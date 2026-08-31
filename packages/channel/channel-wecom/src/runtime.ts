/** Enterprise WeCom delivery, Agent, persistence, streaming, and teardown runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { createUserMessage, errorChain, type LlmCallConfig, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ResolvedConfig } from './config.ts'
import type { ChannelWeComDomain } from './domain.ts'
import { conversationIdentity, deliveryIdentity } from './identity.ts'
import { WeComReplyStream, boundUtf8 } from './stream.ts'
import type { WeComChannelClient, WeComTextDelivery } from './types.ts'
import { admitTextFrame } from './validation.ts'

interface PromptInterval {
  readonly agent: Agent
  readonly messageId: string
  readonly stream: WeComReplyStream
  readonly turnDone: Promise<TurnEndReason>
  readonly settleTurn: (reason: TurnEndReason) => void
  turn?: number
  output: string
}

interface RuntimeOptions {
  readonly config: ResolvedConfig
  readonly client: WeComChannelClient
  readonly domain: ChannelWeComDomain
  readonly identitySecret: string
  readonly workspace: Workspace
  readonly modelSelection: ModelSelection
  readonly persisted: Set<SessionId>
}

/** Apply the creation-time model selection until the first request header exists. */
function installInitialModelSelection(agentCtx: Context, selection: ModelSelection): void {
  agentCtx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
    const agent = agentCtx.agent
    /* v8 ignore next -- AgentRegistry setup always provides its unpublished Agent. */
    if (agent === undefined) throw new Error('channel-wecom: Agent setup has no scoped Agent')
    if (agent.session.requestHeader() !== undefined
      || resolved.provider !== selection.provider
      || resolved.model !== selection.model) return resolved
    const { reasoningEffort: _inheritedEffort, ...base } = resolved
    return { ...base, ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort } }
  })
}

/** Await one promise with a channel-owned timeout and disposal signal. */
function withTimeout<T>(promise: Promise<T>, milliseconds: number, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('channel-wecom: Agent turn timed out')) }, milliseconds)
    const abort = (): void => { reject(signal.reason instanceof Error ? signal.reason : new Error('channel-wecom disposed')) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }).catch(() => {})
  })
}

/** Long-lived protocol driver. Each conversation is serialized; distinct conversations may run concurrently. */
export class WeComChannelRuntime {
  private readonly controller = new AbortController()
  private readonly conversations = new Map<string, Promise<void>>()
  private readonly active = new Map<SessionId, PromptInterval>()
  private readonly handles = new Set<AgentHandle>()
  private readonly disposers: Array<() => void> = []
  private outboxTail = Promise.resolve()
  private retryTimer: ReturnType<typeof setInterval> | undefined
  private closing: Promise<void> | undefined

  /** @param ctx - host services; @param options - validated and pre-resolved runtime inputs. */
  constructor(private readonly ctx: Context, private readonly options: RuntimeOptions) {
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      this.onInboxClaimed(agent, message, turn)
    }))
    this.disposers.push(ctx.on('session/event', (session, event) => { this.onSessionEvent(session, event) }))
    this.disposers.push(ctx.on('agent/error', ({ agent, turn, error }) => {
      const interval = this.active.get(agent.session.id)
      if (interval?.agent === agent && interval.turn === turn) {
        this.ctx.logger.warn(`channel-wecom: Agent turn failed: ${errorChain(error)}`)
      }
    }))
  }

  /** Register callbacks, connect, and start durable outbox retry. */
  async start(): Promise<void> {
    this.disposers.push(this.options.client.onText((frame) => { this.receive(frame) }))
    this.disposers.push(this.options.client.onAuthenticated(() => { this.queueOutboxDrain() }))
    await this.options.client.connect(this.controller.signal)
    this.retryTimer = setInterval(() => { this.queueOutboxDrain() }, this.options.config.outboxRetryIntervalMs)
    this.queueOutboxDrain()
    await this.outboxTail
  }

  /** Hide ingress, abort active Agents, drain owned work, and close transport and storage. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      for (const dispose of this.disposers.splice(0)) dispose()
      if (this.retryTimer !== undefined) clearInterval(this.retryTimer)
      this.controller.abort(new Error('channel-wecom disposed'))
      for (const handle of this.handles) handle.agent.cancel({ kind: 'disposed' })
      await this.options.client.disconnect()
      await Promise.allSettled([...this.conversations.values()])
      await Promise.allSettled([...this.handles].map(handle => handle.dispose()))
      await this.outboxTail
      await this.options.domain.close()
    })()
    return this.closing
  }

  private receive(frame: unknown): void {
    if (this.controller.signal.aborted) return
    let delivery: WeComTextDelivery
    try {
      delivery = admitTextFrame(frame, this.options.config)
    } catch (error: unknown) {
      this.ctx.logger.warn(`channel-wecom: rejected inbound frame: ${errorChain(error)}`)
      void this.options.client.replyStream(
        frame,
        this.options.client.createStreamId(),
        this.options.config.messages.unauthorized,
        true,
      ).catch((failure: unknown) => {
        this.ctx.logger.warn(`channel-wecom: rejection reply failed: ${errorChain(failure)}`)
      })
      return
    }
    const identity = conversationIdentity(
      this.options.config.botId,
      this.options.identitySecret,
      this.options.config.groupConversationMode,
      delivery,
    )
    const previous = this.conversations.get(identity.key) ?? Promise.resolve()
    const current = previous.then(() => this.process(identity.key, identity.sessionId, delivery))
      .catch((error: unknown) => {
        this.ctx.logger.warn(`channel-wecom: delivery failed: ${errorChain(error)}`)
      })
      .finally(() => {
        if (this.conversations.get(identity.key) === current) this.conversations.delete(identity.key)
      })
    this.conversations.set(identity.key, current)
  }

  private async process(conversationKey: string, sessionId: SessionId, delivery: WeComTextDelivery): Promise<void> {
    this.controller.signal.throwIfAborted()
    const deliveryKey = deliveryIdentity(this.options.config.botId, this.options.identitySecret, delivery.messageId)
    const deliveries = this.options.domain.table('deliveries')
    let duplicate = deliveries.get(deliveryKey)
    if (duplicate?.state === 'processing' && duplicate.updatedAt < Date.now() - this.options.config.turnTimeoutMs) {
      await deliveries.delete(deliveryKey)
      duplicate = undefined
    }
    if (duplicate !== undefined) {
      const reply = duplicate.state === 'processing' ? this.options.config.messages.duplicate : duplicate.reply
      await this.options.client.replyStream(delivery.frame, this.options.client.createStreamId(), reply, true)
      return
    }
    const now = Date.now()
    await this.options.domain.table('conversations').put(conversationKey, {
      sessionId,
      target: delivery.target,
      chatType: delivery.chatType,
      updatedAt: now,
    })
    await deliveries.put(deliveryKey, { conversationKey, state: 'processing', reply: '', updatedAt: now })

    const stream = new WeComReplyStream({
      client: this.options.client,
      frame: delivery.frame,
      streamId: this.options.client.createStreamId(),
      flushIntervalMs: this.options.config.streamFlushIntervalMs,
      maxReplyBytes: this.options.config.maxReplyBytes,
    })
    let finalReply = this.options.config.messages.failure
    try {
      await stream.start(this.options.config.messages.processing)
      const result = await this.runAgent(sessionId, delivery, stream)
      finalReply = result.trim() === '' ? this.options.config.messages.emptyReply : result
      await this.deliverFinal(stream, delivery.target, finalReply)
      await deliveries.put(deliveryKey, { conversationKey, state: 'completed', reply: finalReply, updatedAt: Date.now() })
    } catch (error: unknown) {
      const timedOut = error instanceof Error && error.message.includes('timed out')
      finalReply = timedOut ? this.options.config.messages.timeout : this.options.config.messages.failure
      this.ctx.logger.warn(`channel-wecom: processing failed: ${errorChain(error)}`)
      await this.deliverFinal(stream, delivery.target, finalReply).catch((failure: unknown) => {
        this.ctx.logger.warn(`channel-wecom: failure reply delivery failed: ${errorChain(failure)}`)
      })
      await deliveries.put(deliveryKey, { conversationKey, state: 'failed', reply: finalReply, updatedAt: Date.now() })
    } finally {
      await stream.close().catch(() => {})
      await this.pruneDeliveries()
    }
  }

  private async runAgent(sessionId: SessionId, delivery: WeComTextDelivery, stream: WeComReplyStream): Promise<string> {
    if (this.ctx.agents.get(sessionId) !== undefined) throw new Error(`channel-wecom: Session is already active: ${sessionId}`)
    const existing = this.options.persisted.has(sessionId)
    const setup = async (agentCtx: Context): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, this.options.config.agentPreset)
      installInitialModelSelection(agentCtx, this.options.modelSelection)
    }
    const agentOptions = { provider: this.options.modelSelection.provider, model: this.options.modelSelection.model }
    const handle = existing
      ? await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions,
          signal: this.controller.signal,
          setup,
        })
      : await this.ctx.agents.create({
        sessionId,
        signal: this.controller.signal,
        meta: { cwd: this.options.workspace.path, agentPreset: this.options.config.agentPreset },
        agentOptions,
        setup,
      })
    this.handles.add(handle)
    try {
      await this.options.workspace.attachSession(sessionId)
      this.ctx.permissionPresets.set(handle.agent.session, this.options.config.permissionPreset)
      if (!existing) this.ctx.sessionTitle.rename(handle.agent.session, `${this.options.config.sessionTitlePrefix} ${delivery.chatType}`)
      const message = createUserMessage({ content: [{ type: 'text', text: delivery.text }], source: { kind: 'user' } })
      const completion = Promise.withResolvers<TurnEndReason>()
      const interval: PromptInterval = {
        agent: handle.agent,
        messageId: message.id,
        stream,
        turnDone: completion.promise,
        settleTurn: completion.resolve,
        output: '',
      }
      this.active.set(sessionId, interval)
      handle.agent.followup(message)
      let reason: TurnEndReason
      try {
        reason = await withTimeout(interval.turnDone, this.options.config.turnTimeoutMs, this.controller.signal)
      } catch (error: unknown) {
        handle.agent.cancel({ kind: 'user' })
        await handle.agent.whenIdle()
        throw error
      }
      await handle.agent.whenIdle()
      if (reason.kind === 'error') throw new Error(reason.error.message)
      return interval.output
    } finally {
      this.active.delete(sessionId)
      try {
        await this.ctx.sessions.flush(handle.agent.session)
        this.options.persisted.add(sessionId)
      } finally {
        await handle.dispose()
        this.handles.delete(handle)
      }
    }
  }

  private onInboxClaimed(agent: Agent, message: UserMessage, turn: number): void {
    const interval = this.active.get(agent.session.id)
    if (interval?.agent === agent && interval.messageId === message.id) interval.turn = turn
  }

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const interval = this.active.get(session.id)
    if (interval === undefined || interval.agent.session !== session || interval.turn === undefined) return
    if (event.type === 'assistant/chunk' && event.data.turn === interval.turn && event.data.chunk.type === 'text-delta') {
      interval.output += event.data.chunk.text
      interval.stream.append(event.data.chunk.text)
    } else if (event.type === 'turn/end' && event.data.turn === interval.turn) {
      interval.settleTurn(event.data.reason)
    }
  }

  private async deliverFinal(stream: WeComReplyStream, target: string, content: string): Promise<void> {
    const bounded = boundUtf8(content, this.options.config.maxReplyBytes)
    try {
      await stream.finish(bounded)
    } catch (error: unknown) {
      try {
        await this.options.client.sendMarkdown(target, bounded)
      } catch (fallbackError: unknown) {
        await this.enqueueOutbox(target, bounded)
        this.ctx.logger.warn(
          `channel-wecom: reply queued after passive and active delivery failed: ${errorChain(new AggregateError([error, fallbackError]))}`,
        )
      }
    }
  }

  private async enqueueOutbox(target: string, content: string): Promise<void> {
    const key = this.options.client.createStreamId()
    const now = Date.now()
    await this.options.domain.table('outbox').put(key, { target, content, attempts: 0, createdAt: now, updatedAt: now })
  }

  private queueOutboxDrain(): void {
    this.outboxTail = this.outboxTail.then(() => this.drainOutbox()).catch((error: unknown) => {
      this.ctx.logger.warn(`channel-wecom: outbox drain failed: ${errorChain(error)}`)
    })
  }

  private async drainOutbox(): Promise<void> {
    if (this.controller.signal.aborted) return
    const table = this.options.domain.table('outbox')
    for (const [key, item] of table.entries()) {
      try {
        await this.options.client.sendMarkdown(item.target, item.content)
        await table.delete(key)
      } catch (error: unknown) {
        const attempts = item.attempts + 1
        if (attempts >= this.options.config.maxOutboxAttempts) {
          this.ctx.logger.warn(`channel-wecom: dropping exhausted outbox item: ${errorChain(error)}`)
          await table.delete(key)
        } else {
          await table.put(key, { ...item, attempts, updatedAt: Date.now() })
        }
      }
    }
  }

  private async pruneDeliveries(): Promise<void> {
    const table = this.options.domain.table('deliveries')
    const records = [...table.entries()].sort((left, right) => left[1].updatedAt - right[1].updatedAt)
    const expiredBefore = Date.now() - this.options.config.deliveryRetentionMs
    const overflow = Math.max(0, records.length - this.options.config.maxDeliveryRecords)
    for (let index = 0; index < records.length; index += 1) {
      const entry = records[index]
      if (entry !== undefined && (index < overflow || entry[1].updatedAt < expiredBefore)) await table.delete(entry[0])
    }
  }
}
