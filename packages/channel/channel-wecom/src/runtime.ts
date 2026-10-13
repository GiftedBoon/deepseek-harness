/** Enterprise WeCom delivery, Agent, persistence, streaming, and teardown runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AssistantStreamFrame, ModelSelection } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { createUserMessage, errorChain, type LlmCallConfig, type UserMessage } from '@deepseek-ai/dsh-llm'
import { renderTaskFraming, type ScheduleExecution, type ScheduleExecutionId, type ScheduleExecutionOutcome } from '@deepseek-ai/dsh-schedule'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type { ResolvedConfig } from './config.ts'
import type { ChannelWeComDomain } from './domain.ts'
import type { WeComScheduledActionInputDomain } from './scheduled-action-input-domain.ts'
import type { WeComScheduledActionDomain } from './scheduled-action-domain.ts'
import { WeComScheduledActions } from './scheduled-actions.ts'
import { conversationIdentity, deliveryIdentity } from './identity.ts'
import { WeComReplyStream, boundUtf8 } from './stream.ts'
import type { WeComChannelClient, WeComTextDelivery } from './types.ts'
import { weComTaskReportDomainSpec, type WeComTaskReportDomain } from './task-report-domain.ts'
import { admitTextFrame } from './validation.ts'

class ScheduledTaskExpired extends Error {}

interface PromptInterval {
  readonly agent: Agent
  readonly messageId: string
  readonly stream?: WeComReplyStream
  readonly turnDone: Promise<TurnEndReason>
  readonly settleTurn: (reason: TurnEndReason) => void
  attemptId?: AssistantStreamFrame['attemptId']
  turn?: number
  output: string
  committedOutput: string
  readonly messageIds: MessageId[]
}

interface RuntimeOptions {
  readonly config: ResolvedConfig
  readonly client: WeComChannelClient
  readonly domain: ChannelWeComDomain
  readonly scheduledActionDomain: WeComScheduledActionDomain
  readonly scheduledActionInputDomain: WeComScheduledActionInputDomain
  readonly identitySecret: string
  readonly workspace: Workspace
  readonly modelSelection: ModelSelection
}

interface OutboxDrainOptions {
  /** Deliver only items addressed to this conversation target. */
  readonly target?: string
  /** Retry items whose periodic attempts are exhausted. Defaults to true. */
  readonly retryExhausted?: boolean
}

/** Apply the creation-time model selection until the first request header exists. */
function installInitialModelSelection(agentCtx: Context, agent: Agent, selection: ModelSelection): void {
  agentCtx.on('agent/request', async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next()
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
    const cleanup = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const fail = (error: unknown): void => { cleanup(); reject(error instanceof Error ? error : new Error(String(error))) }
    const abort = (): void => { fail(signal.reason instanceof Error ? signal.reason : new Error('channel-wecom disposed')) }
    const timer = setTimeout(() => { fail(new Error('channel-wecom: Agent turn timed out')) }, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
    promise.then((value) => { cleanup(); resolve(value) }, fail)
    if (signal.aborted) abort()
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
  private taskReports: WeComTaskReportDomain | undefined
  private readonly scheduledActions: WeComScheduledActions

  /** @param ctx - host services; @param options - validated and pre-resolved runtime inputs. */
  constructor(private readonly ctx: Context, private readonly options: RuntimeOptions) {
    if (options.config.notificationChatId !== undefined
      && (options.config.notificationChatId === '*' || !options.config.allowedChats.includes(options.config.notificationChatId))) {
      throw new Error('channel-wecom: notificationChatId must name an exact allowedChats entry')
    }
    this.scheduledActions = new WeComScheduledActions(ctx, {
      config: options.config,
      conversations: options.domain,
      actions: options.scheduledActionDomain,
      inputs: options.scheduledActionInputDomain,
      enqueueNotification: (target, content) => this.enqueueScheduledNotification(target, content),
    })
    this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      this.onInboxClaimed(agent, message, turn)
    }))
    this.disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      this.onAssistantStream(agent, frame)
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
    const schedule = this.ctx.get('schedule')
    if (schedule !== undefined) {
      this.taskReports = await this.ctx.storageDomain.open(weComTaskReportDomainSpec)
      this.disposers.push(this.ctx.on('schedule/execution', (execution) => {
        if (execution.status === 'queued' || execution.status === 'running') return
        this.queueTaskReport(execution)
      }))
      for (const [, conversation] of this.options.domain.table('conversations').entries()) {
        let before: ScheduleExecutionId | undefined
        for (;;) {
          const executions = await schedule.executions({
            sessionId: conversation.sessionId as SessionId, limit: 100,
            ...(before === undefined ? {} : { before }),
          })
          for (const execution of executions) {
            if (execution.status !== 'queued' && execution.status !== 'running') this.queueTaskReport(execution)
          }
          const last = executions.at(-1)
          if (last === undefined || executions.length < 100) break
          before = last.id
        }
      }
      // Executions can prune recovery cursors, so admission starts after paging finishes.
      this.disposers.push(schedule.registerTaskExecutor({
        id: 'wecom',
        accepts: sessionId => this.conversationForSession(sessionId) !== undefined,
        execute: (execution, signal) => this.executeScheduledTask(execution, signal),
      }))
    }
    await this.options.client.connect(this.controller.signal)
    await this.scheduledActions.start()
    this.retryTimer = setInterval(() => { this.queueOutboxDrain({ retryExhausted: false }) }, this.options.config.outboxRetryIntervalMs)
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
      await this.scheduledActions.close()
      await this.options.client.disconnect()
      await Promise.allSettled([...this.conversations.values()])
      await Promise.allSettled([...this.handles].map(handle => handle.dispose()))
      await this.outboxTail
      await this.options.scheduledActionInputDomain.close()
      await this.options.scheduledActionDomain.close()
      await this.taskReports?.close()
      await this.options.domain.close()
    })()
    return this.closing
  }

  /**
   * Admit one Host report to the existing durable outbox for the configured group.
   * @param content - Markdown bounded by maxReplyBytes.
   * @returns Resolves after persistence; sending and retries continue independently on the existing connection.
   */
  enqueueNotification(content: string): Promise<void> {
    const target = this.options.config.notificationChatId
    if (target === undefined) return Promise.reject(new Error('channel-wecom: notificationChatId is not configured'))
    const admitted = this.outboxTail.then(async () => {
      this.controller.signal.throwIfAborted()
      await this.enqueueOutbox(target, boundUtf8(content, this.options.config.maxReplyBytes))
    })
    this.outboxTail = admitted.catch(() => {})
    this.queueOutboxDrain({ target })
    return admitted
  }

  private conversationForSession(sessionId: SessionId) {
    return [...this.options.domain.table('conversations').entries()]
      .find(([, record]) => record.sessionId === sessionId)
  }

  private routeAllowed(conversation: { target: string; chatType: 'single' | 'group' }): boolean {
    const allowed = conversation.chatType === 'group' ? this.options.config.allowedChats : this.options.config.allowedUsers
    return conversation.target !== '*' && allowed.includes(conversation.target)
  }

  private executeScheduledTask(execution: ScheduleExecution, signal: AbortSignal): Promise<ScheduleExecutionOutcome> {
    const mapped = this.conversationForSession(execution.sessionId)
    if (mapped === undefined) return Promise.reject(new Error('channel-wecom: scheduled Session has no conversation route'))
    return this.serializeConversation(mapped[0], async () => {
      const route = this.options.domain.table('conversations').get(mapped[0])
      if (route === undefined || !this.routeAllowed(route)) {
        return { status: 'failed', error: 'The original WeCom conversation is no longer explicitly allowed.' }
      }
      const combined = AbortSignal.any([signal, this.controller.signal])
      try {
        combined.throwIfAborted()
        const result = await this.runAgent(
          mapped[0], execution.sessionId, renderTaskFraming(execution), route.chatType, undefined,
          combined, execution.inputMessageId, execution.expiresAt,
        )
        return { status: result.reason.kind === 'completed' ? 'completed' : 'interrupted', inputMessageId: result.inputMessageId, messageIds: result.messageIds, output: result.committedOutput,
          ...(result.reason.kind === 'completed' ? {} : { error: `Agent turn ended: ${result.reason.kind}` }),
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`channel-wecom: scheduled Agent execution failed: ${errorChain(error)}`)
        return { status: combined.aborted || error instanceof ScheduledTaskExpired ? 'interrupted' : 'failed',
          ...(error instanceof ScheduledTaskExpired ? { interruptionReason: 'expired' as const } : combined.aborted ? { interruptionReason: 'unloaded' as const } : {}),
          error: error instanceof Error ? error.message : 'Agent execution failed',
        }
      }
    })
  }

  private queueTaskReport(execution: ScheduleExecution): void {
    if (execution.providerId !== 'wecom' || execution.interruptionReason === 'cancelled' || execution.interruptionReason === 'expired') return
    const mapped = this.conversationForSession(execution.sessionId)
    if (mapped === undefined || !this.routeAllowed(mapped[1])) return
    const content = execution.status === 'completed' ? execution.output ?? ''
      : execution.status === 'interrupted' ? this.options.config.messages.scheduledActionUncertain : this.options.config.messages.failure
    if (content.trim() === '' || Date.parse(execution.createdAt) < Date.now() - this.options.config.outboxRetentionMs) return
    const key = `task:${execution.id}`
    this.outboxTail = this.outboxTail.then(async () => {
      this.controller.signal.throwIfAborted()
      const receipts = this.taskReports?.table('reports')
      if (receipts === undefined || receipts.get(key) !== undefined) return
      const now = Date.now()
      const bounded = boundUtf8(content, this.options.config.maxReplyBytes)
      if (bounded === '') return
      await this.options.domain.table('outbox').put(key, {
        target: mapped[1].target, content: bounded, attempts: 0, createdAt: now, updatedAt: now,
      })
      await receipts.put(key, { state: 'queued', sessionId: execution.sessionId, createdAt: now })
    }).catch((error: unknown) => {
      this.ctx.logger.warn(`channel-wecom: scheduled report admission failed: ${errorChain(error)}`)
    })
    this.queueOutboxDrain({ target: mapped[1].target })
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
    void this.serializeConversation(identity.key, () => this.process(identity.key, identity.sessionId, delivery)).catch(() => {})
  }

  private serializeConversation<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.conversations.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const current = result.then(() => {})
      .catch((error: unknown) => {
        this.ctx.logger.warn(`channel-wecom: delivery failed: ${errorChain(error)}`)
      })
      .finally(() => {
        if (this.conversations.get(key) === current) this.conversations.delete(key)
      })
    this.conversations.set(key, current)
    return result
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
    // A conversation that just wrote in is the reliable moment to deliver what the
    // provider refused while it was idle.
    this.queueOutboxDrain({ target: delivery.target })

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
      const result = await this.runAgent(conversationKey, sessionId, delivery.text, delivery.chatType, stream)
      finalReply = result.output.trim() === '' ? this.options.config.messages.emptyReply : result.output
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

  private async runAgent(
    conversationKey: string,
    sessionId: SessionId,
    text: string,
    chatType: string,
    stream?: WeComReplyStream,
    signal: AbortSignal = this.controller.signal,
    inputMessageId?: MessageId,
    expiresAt?: string,
  ): Promise<{ output: string; committedOutput: string; inputMessageId: MessageId; messageIds: MessageId[]; reason: TurnEndReason }> {
    if (this.ctx.agents.get(sessionId) !== undefined) throw new Error(`channel-wecom: Session is already active: ${sessionId}`)
    const existing = await this.ctx.sessionPersistence.stat(sessionId, { signal: this.controller.signal }) !== undefined
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      await this.ctx.agentPresets.mount(agentCtx, this.options.config.agentPreset)
      installInitialModelSelection(agentCtx, agent, this.options.modelSelection)
      this.scheduledActions.register(agentCtx, agent, conversationKey)
    }
    const agentOptions = { provider: this.options.modelSelection.provider, model: this.options.modelSelection.model }
    const handle = existing
      ? await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions,
        signal,
        setup,
      })
      : await this.ctx.agents.create({
        sessionId,
        signal,
        meta: { cwd: this.options.workspace.path, agentPreset: this.options.config.agentPreset },
        agentOptions,
        setup,
      })
    this.handles.add(handle)
    try {
      await this.options.workspace.attachSession(sessionId)
      this.ctx.permissionPresets.set(handle.agent.session, this.options.config.permissionPreset)
      if (!existing) this.ctx.sessionTitle.rename(handle.agent.session, `${this.options.config.sessionTitlePrefix} ${chatType}`)
      const generated = createUserMessage({ content: [{ type: 'text', text }], source: inputMessageId === undefined ? { kind: 'user' } : { kind: 'schedule' } })
      const message = inputMessageId === undefined ? generated : Object.freeze({ ...generated, id: inputMessageId })
      const completion = Promise.withResolvers<TurnEndReason>()
      const interval: PromptInterval = {
        agent: handle.agent,
        messageId: message.id,
        ...stream === undefined ? {} : { stream },
        turnDone: completion.promise,
        settleTurn: completion.resolve,
        output: '',
        committedOutput: '',
        messageIds: [],
      }
      this.active.set(sessionId, interval)
      signal.throwIfAborted()
      if (expiresAt !== undefined && Date.now() >= Date.parse(expiresAt)) throw new ScheduledTaskExpired('Scheduled task expired before input delivery')
      handle.agent.followup(message)
      let reason: TurnEndReason
      try {
        if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('Session persistence did not acknowledge channel input')
        reason = await withTimeout(interval.turnDone, this.options.config.turnTimeoutMs, signal)
      } catch (error: unknown) {
        handle.agent.cancel({ kind: 'user' })
        await handle.agent.whenIdle()
        throw error
      }
      await handle.agent.whenIdle()
      if (reason.kind === 'error') throw new Error(reason.error.message)
      if (reason.kind === 'blocked') {
        throw new Error('WeCom Agent turn was blocked; check Session archive state and admission policy')
      }
      return { output: interval.output, committedOutput: interval.committedOutput,
        inputMessageId: message.id, messageIds: interval.messageIds, reason,
      }
    } finally {
      this.active.delete(sessionId)
      try {
        if (!await this.ctx.sessions.flush(handle.agent.session)) throw new Error('Session persistence did not acknowledge channel output')
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
    if (event.type === 'assistant/message' && event.data.turn === interval.turn && event.data.interrupted !== true) {
      interval.messageIds.push(event.data.message.id)
      const text = event.data.message.content.filter(item => item.type === 'text').map(item => item.text).join('')
      interval.committedOutput = boundUtf8(interval.committedOutput + text, this.options.config.maxReplyBytes)
    }
    if (event.type === 'turn/end' && event.data.turn === interval.turn) {
      interval.settleTurn(event.data.reason)
    }
  }

  private onAssistantStream(agent: Agent, frame: AssistantStreamFrame): void {
    const interval = this.active.get(agent.session.id)
    if (interval === undefined || interval.agent !== agent || interval.turn === undefined) return
    if (frame.type === 'start') {
      if (frame.turn === interval.turn) interval.attemptId = frame.attemptId
      return
    }
    if (frame.attemptId !== interval.attemptId) return
    if (frame.type === 'end') {
      delete interval.attemptId
    } else if (frame.chunk.type === 'text-delta') {
      interval.output += frame.chunk.text
      interval.stream?.append(frame.chunk.text)
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

  private async enqueueScheduledNotification(target: string, content: string): Promise<void> {
    await this.enqueueOutbox(target, boundUtf8(content, this.options.config.maxReplyBytes))
    this.queueOutboxDrain({ target })
  }

  private queueOutboxDrain(options: OutboxDrainOptions = {}): void {
    this.outboxTail = this.outboxTail.then(() => this.drainOutbox(options)).catch((error: unknown) => {
      this.ctx.logger.warn(`channel-wecom: outbox drain failed: ${errorChain(error)}`)
    })
  }

  private async drainOutbox(options: OutboxDrainOptions): Promise<void> {
    if (this.controller.signal.aborted) return
    const table = this.options.domain.table('outbox')
    const expiredBefore = Date.now() - this.options.config.outboxRetentionMs
    const receipts = this.taskReports?.table('reports')
    for (const [key, receipt] of receipts?.entries() ?? []) {
      if (receipt.createdAt < expiredBefore && receipt.state !== 'queued') await receipts?.delete(key)
    }
    for (const [key, item] of [...table.entries()]) {
      const receipt = receipts?.get(key)
      if (receipt !== undefined) {
        const conversation = this.conversationForSession(receipt.sessionId)
        if (receipt.state !== 'queued' || conversation === undefined || !this.routeAllowed(conversation[1]) || conversation[1].target !== item.target) {
          await table.delete(key)
          if (receipt.state === 'queued') await receipts?.put(key, { ...receipt, state: 'expired' })
          continue
        }
      }
      if (item.createdAt < expiredBefore) {
        if (receipt !== undefined) await receipts?.put(key, { ...receipt, state: 'expired' })
        await table.delete(key)
        this.ctx.logger.warn('channel-wecom: outbox item expired before delivery')
        continue
      }
      if (key.startsWith('task:') && receipt === undefined) continue
      if (options.target !== undefined && item.target !== options.target) continue
      if (options.retryExhausted === false && item.attempts >= this.options.config.maxOutboxAttempts) continue
      try {
        await this.options.client.sendMarkdown(item.target, item.content)
        if (receipt !== undefined) await receipts?.put(key, { ...receipt, state: 'delivered' })
        await table.delete(key)
      } catch (error: unknown) {
        const attempts = item.attempts + 1
        await table.put(key, { ...item, attempts, updatedAt: Date.now() })
        // The target and the content carry provider identity and message text, so
        // only the attempt count and the provider diagnostic reach the log.
        this.ctx.logger.warn(`channel-wecom: outbox send failed on attempt ${attempts}: ${errorChain(error)}`)
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
