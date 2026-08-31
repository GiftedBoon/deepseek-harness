import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.ts'
import { conversationIdentity, deliveryIdentity } from '../src/identity.ts'
import { WeComChannelRuntime } from '../src/runtime.ts'
import type { WeComChannelClient } from '../src/types.ts'

interface DeliveryRecord {
  conversationKey: string
  state: 'processing' | 'completed' | 'failed'
  reply: string
  updatedAt: number
}

interface OutboxRecord {
  target: string
  content: string
  attempts: number
  createdAt: number
  updatedAt: number
}

class Table<T> {
  readonly records = new Map<string, T>()
  get(key: string): T | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, T]> { return this.records.entries() }
  put(key: string, value: T): Promise<void> { this.records.set(key, value); return Promise.resolve() }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.records.delete(key)) }
}

class Domain {
  readonly conversations = new Table<Record<string, unknown>>()
  readonly deliveries = new Table<DeliveryRecord>()
  readonly outbox = new Table<OutboxRecord>()
  closed = 0

  table(name: string): Table<unknown> {
    if (name === 'conversations') return this.conversations as Table<unknown>
    if (name === 'deliveries') return this.deliveries as Table<unknown>
    if (name === 'outbox') return this.outbox as Table<unknown>
    throw new Error(`unexpected table: ${name}`)
  }

  close(): Promise<void> { this.closed++; return Promise.resolve() }
}

class Client implements WeComChannelClient {
  readonly replies: Array<{ frame: unknown; streamId: string; content: string; finish: boolean }> = []
  readonly sends: Array<{ target: string; content: string }> = []
  readonly textListeners = new Set<(frame: unknown) => void>()
  readonly authListeners = new Set<() => void>()
  connectError: Error | undefined
  failFinal = false
  failSend = false
  disconnected = 0
  private ids = 0

  connect(): Promise<void> { return this.connectError === undefined ? Promise.resolve() : Promise.reject(this.connectError) }
  disconnect(): Promise<void> { this.disconnected++; return Promise.resolve() }
  onText(listener: (frame: unknown) => void): () => void {
    this.textListeners.add(listener)
    return () => { this.textListeners.delete(listener) }
  }
  onAuthenticated(listener: () => void): () => void {
    this.authListeners.add(listener)
    return () => { this.authListeners.delete(listener) }
  }
  createStreamId(): string { this.ids++; return `stream-${this.ids}` }
  replyStream(frame: unknown, streamId: string, content: string, finish: boolean): Promise<void> {
    this.replies.push({ frame, streamId, content, finish })
    return this.failFinal && finish ? Promise.reject(new Error('passive failed')) : Promise.resolve()
  }
  sendMarkdown(target: string, content: string): Promise<void> {
    this.sends.push({ target, content })
    return this.failSend ? Promise.reject(new Error('active failed')) : Promise.resolve()
  }
  emitText(frame: unknown): void { for (const listener of this.textListeners) listener(frame) }
  emitAuthenticated(): void { for (const listener of this.authListeners) listener() }
}

interface AgentBehavior {
  output?: string
  complete?: boolean
  reason?: { kind: 'completed' } | { kind: 'error'; error: { message: string } }
  requestHeader?: object
  activeConflict?: boolean
  emitAgentError?: boolean
}

interface RuntimeHarness {
  readonly runtime: WeComChannelRuntime
  readonly client: Client
  readonly domain: Domain
  readonly config: ResolvedConfig
  readonly calls: string[]
  readonly modelResults: unknown[]
  readonly warnings: ReturnType<typeof vi.fn>
  emit(name: string, ...args: unknown[]): void
}

const runtimes: WeComChannelRuntime[] = []

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map(runtime => runtime.close()))
  vi.useRealTimers()
})

function baseConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'KEY', workspacePath: '/workspace',
    agentPreset: 'standard', permissionPreset: 'wecom', groupConversationMode: 'shared',
    allowedUsers: ['allowed'], allowedChats: ['chat'], sessionTitlePrefix: 'WeCom',
    connectTimeoutMs: 20, streamFlushIntervalMs: 1, maxInputBytes: 100, maxReplyBytes: 100,
    turnTimeoutMs: 50, deliveryRetentionMs: 100_000, maxDeliveryRecords: 100,
    outboxRetryIntervalMs: 100_000, maxOutboxAttempts: 2,
    messages: {
      processing: 'processing', timeout: 'timeout', failure: 'failure', emptyReply: 'empty',
      unauthorized: 'unauthorized', duplicate: 'duplicate',
    },
    ...overrides,
  }
}

function frame(overrides: Record<string, unknown> = {}): unknown {
  return {
    headers: { req_id: 'request' },
    body: {
      msgid: 'message', aibotid: 'bot', chattype: 'single', from: { userid: 'allowed' },
      msgtype: 'text', text: { content: 'hello' }, ...overrides,
    },
  }
}

function harness(options: {
  behavior?: AgentBehavior
  config?: Partial<ResolvedConfig>
  persisted?: boolean
  client?: Client
  domain?: Domain
} = {}): RuntimeHarness {
  const behavior = options.behavior ?? {}
  const config = baseConfig(options.config)
  const client = options.client ?? new Client()
  const domain = options.domain ?? new Domain()
  const calls: string[] = []
  const modelResults: unknown[] = []
  const warnings = vi.fn()
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const emit = (name: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  const on = (name: string, listener: (...args: unknown[]) => void): (() => void) => {
    const current = listeners.get(name) ?? new Set()
    current.add(listener)
    listeners.set(name, current)
    return () => { current.delete(listener) }
  }

  const createHandle = async (agentOptions: {
    sessionId?: string
    resumeSessionId?: string
    setup?: (ctx: unknown) => Promise<void>
    agentOptions?: unknown
  }, operation: 'create' | 'resume') => {
    calls.push(operation)
    calls.push(`agent-options:${JSON.stringify(agentOptions.agentOptions)}`)
    const session = {
      id: agentOptions.sessionId ?? agentOptions.resumeSessionId ?? 'missing',
      requestHeader: () => behavior.requestHeader,
    }
    const agent = {
      session,
      cancel: () => { calls.push('cancel') },
      whenIdle: () => Promise.resolve(),
      followup: (message: { id: string }) => {
        calls.push('followup')
        if (behavior.complete === false) return
        queueMicrotask(() => {
          emit('session/event', { id: 'other' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
          emit('agent/inbox/claimed', { agent, message: { id: 'other' }, turn: 9 })
          emit('agent/inbox/claimed', { agent, message, turn: 1 })
          emit('session/event', session, { type: 'assistant/chunk', data: { turn: 2, chunk: { type: 'text-delta', text: 'wrong' } } })
          emit('session/event', session, { type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'reasoning-delta', text: 'hidden' } } })
          if (behavior.emitAgentError) emit('agent/error', { agent, turn: 1, error: new Error('observed failure') })
          if (behavior.output !== undefined && behavior.output !== '') {
            emit('session/event', session, { type: 'assistant/chunk', data: { turn: 1, chunk: { type: 'text-delta', text: behavior.output } } })
          }
          emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: behavior.reason ?? { kind: 'completed' } } })
        })
      },
    }
    const requestListeners: Array<(_payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    await agentOptions.setup?.({
      agent,
      on: (name: string, listener: (_payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
        if (name === 'agent/request') requestListeners.push(listener)
        return () => {}
      },
    })
    for (const listener of requestListeners) {
      modelResults.push(await listener({}, async () => ({ provider: 'provider', model: 'model', reasoningEffort: 'low', temperature: 1 })))
      modelResults.push(await listener({}, async () => ({ provider: 'other', model: 'model' })))
    }
    return {
      agent,
      dispose: async () => { calls.push('dispose') },
    }
  }

  const ctx = {
    logger: { warn: warnings },
    on,
    agents: {
      get: () => behavior.activeConflict ? {} : undefined,
      create: (agentOptions: never) => createHandle(agentOptions, 'create'),
      resume: (agentOptions: never) => createHandle(agentOptions, 'resume'),
    },
    agentPresets: { mount: async () => { calls.push('preset') } },
    permissionPresets: { set: () => { calls.push('permission') } },
    sessionTitle: { rename: () => { calls.push('title') } },
    sessions: { flush: async () => { calls.push('flush') } },
  }
  const workspace = {
    path: '/workspace',
    attachSession: async () => { calls.push('attach') },
  }
  const persisted = new Set<string>()
  if (options.persisted) persisted.add(conversationIdentity('bot', 'identity', 'shared', {
    messageId: 'message', requestId: 'request', botId: 'bot', chatType: 'single', userId: 'allowed',
    target: 'allowed', text: 'hello', frame: {},
  }).sessionId)
  const runtime = new WeComChannelRuntime(ctx as never, {
    config,
    client,
    domain: domain as never,
    identitySecret: 'identity',
    workspace: workspace as never,
    modelSelection: { provider: 'provider', model: 'model', reasoningEffort: 'high' },
    persisted: persisted as never,
  })
  runtimes.push(runtime)
  return { runtime, client, domain, config, calls, modelResults, warnings, emit }
}

async function waitForDelivery(domain: Domain, state: DeliveryRecord['state']): Promise<DeliveryRecord> {
  let record: DeliveryRecord | undefined
  await vi.waitFor(() => {
    record = [...domain.deliveries.records.values()].find(candidate => candidate.state === state)
    expect(record).toBeDefined()
  })
  if (record === undefined) throw new Error('delivery did not settle')
  return record
}

describe('WeComChannelRuntime', () => {
  it('creates an Agent, correlates visible output, persists completion, and closes quiescently', async () => {
    const test = harness({ behavior: { output: 'answer', emitAgentError: true } })
    test.emit('session/event', {}, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    test.emit('agent/error', { agent: { session: { id: 'other' } }, turn: 1, error: new Error('ignored') })
    await test.runtime.start()
    test.client.emitText(frame())
    const delivery = await waitForDelivery(test.domain, 'completed')
    expect(delivery.reply).toBe('answer')
    expect(test.client.replies.map(reply => [reply.content, reply.finish])).toEqual([
      ['processing', false],
      ['answer', true],
    ])
    expect(test.calls).toEqual(expect.arrayContaining(['create', 'preset', 'attach', 'permission', 'title', 'followup', 'flush', 'dispose']))
    expect(test.modelResults).toEqual([
      { provider: 'provider', model: 'model', reasoningEffort: 'high', temperature: 1 },
      { provider: 'other', model: 'model' },
    ])
    expect(test.warnings).toHaveBeenCalledWith(expect.stringContaining('observed failure'))
    await test.runtime.close()
    await test.runtime.close()
    expect(test.client.disconnected).toBe(1)
    expect(test.domain.closed).toBe(1)
  })

  it('resumes persisted Sessions and returns the empty-output message', async () => {
    const test = harness({ persisted: true, behavior: { output: '', requestHeader: {} } })
    await test.runtime.start()
    test.client.emitText(frame())
    const delivery = await waitForDelivery(test.domain, 'completed')
    expect(delivery.reply).toBe('empty')
    expect(test.calls).toContain('resume')
    expect(test.calls).not.toContain('title')
    expect(test.modelResults[0]).toMatchObject({ reasoningEffort: 'low' })
  })

  it('replays completed and processing duplicates without another Agent', async () => {
    const test = harness()
    const key = deliveryIdentity('bot', 'identity', 'message')
    test.domain.deliveries.records.set(key, {
      conversationKey: 'conversation', state: 'completed', reply: 'stored', updatedAt: Date.now(),
    })
    await test.runtime.start()
    test.client.emitText(frame())
    await vi.waitFor(() => { expect(test.client.replies.at(-1)?.content).toBe('stored') })
    expect(test.calls).not.toContain('create')

    test.domain.deliveries.records.set(key, {
      conversationKey: 'conversation', state: 'processing', reply: '', updatedAt: Date.now(),
    })
    test.client.emitText(frame())
    await vi.waitFor(() => { expect(test.client.replies.at(-1)?.content).toBe('duplicate') })
  })

  it('replaces a stale processing record and prunes expired and overflow records', async () => {
    const test = harness({
      behavior: { output: 'fresh' },
      config: { turnTimeoutMs: 5, deliveryRetentionMs: 10, maxDeliveryRecords: 2 },
    })
    const key = deliveryIdentity('bot', 'identity', 'message')
    test.domain.deliveries.records.set(key, {
      conversationKey: 'stale', state: 'processing', reply: '', updatedAt: 0,
    })
    test.domain.deliveries.records.set('oldest', {
      conversationKey: 'old', state: 'completed', reply: 'old', updatedAt: 0,
    })
    test.domain.deliveries.records.set('newer', {
      conversationKey: 'new', state: 'completed', reply: 'new', updatedAt: Date.now(),
    })
    await test.runtime.start()
    test.client.emitText(frame())
    await vi.waitFor(() => { expect(test.domain.deliveries.records.get(key)?.reply).toBe('fresh') })
    await vi.waitFor(() => { expect(test.domain.deliveries.records.size).toBeLessThanOrEqual(2) })
    expect(test.domain.deliveries.records.has('oldest')).toBe(false)
  })

  it('rejects invalid ingress and contains rejection-delivery failures', async () => {
    const test = harness()
    await test.runtime.start()
    test.client.emitText({ invalid: true })
    await vi.waitFor(() => { expect(test.client.replies.at(-1)?.content).toBe('unauthorized') })
    expect(test.warnings).toHaveBeenCalledWith(expect.stringContaining('rejected inbound frame'))

    test.client.failFinal = true
    test.client.emitText({ invalid: true })
    await vi.waitFor(() => {
      expect(test.warnings).toHaveBeenCalledWith(expect.stringContaining('rejection reply failed'))
    })
  })

  it('records timeout, Agent error, and active-session failures', async () => {
    const timeout = harness({ behavior: { complete: false }, config: { turnTimeoutMs: 2 } })
    await timeout.runtime.start()
    timeout.client.emitText(frame())
    expect((await waitForDelivery(timeout.domain, 'failed')).reply).toBe('timeout')
    expect(timeout.calls).toContain('cancel')

    const agentError = harness({ behavior: { reason: { kind: 'error', error: { message: 'model failed' } } } })
    await agentError.runtime.start()
    agentError.client.emitText(frame())
    expect((await waitForDelivery(agentError.domain, 'failed')).reply).toBe('failure')

    const conflict = harness({ behavior: { activeConflict: true } })
    await conflict.runtime.start()
    conflict.client.emitText(frame())
    expect((await waitForDelivery(conflict.domain, 'failed')).reply).toBe('failure')
  })

  it('falls back to active send and durably retries a double delivery failure', async () => {
    const active = harness({ behavior: { output: 'answer' } })
    active.client.failFinal = true
    await active.runtime.start()
    active.client.emitText(frame())
    await waitForDelivery(active.domain, 'completed')
    expect(active.client.sends).toContainEqual({ target: 'allowed', content: 'answer' })

    const queued = harness({ behavior: { output: 'queued' } })
    queued.client.failFinal = true
    queued.client.failSend = true
    await queued.runtime.start()
    queued.client.emitText(frame())
    await waitForDelivery(queued.domain, 'completed')
    await vi.waitFor(() => { expect(queued.domain.outbox.records.size).toBe(1) })
    queued.client.failSend = false
    queued.client.emitAuthenticated()
    await vi.waitFor(() => { expect(queued.domain.outbox.records.size).toBe(0) })
  })

  it('drops exhausted outbox items and contains drain failures', async () => {
    const domain = new Domain()
    domain.outbox.records.set('exhausted', {
      target: 'target', content: 'content', attempts: 1, createdAt: 1, updatedAt: 1,
    })
    const client = new Client()
    client.failSend = true
    const test = harness({ domain, client, config: { maxOutboxAttempts: 2 } })
    await test.runtime.start()
    expect(domain.outbox.records.size).toBe(0)
    expect(test.warnings).toHaveBeenCalledWith(expect.stringContaining('dropping exhausted outbox item'))
  })

  it('disposes an active interval and reports startup connection failure', async () => {
    const active = harness({ behavior: { complete: false }, config: { turnTimeoutMs: 10_000 } })
    await active.runtime.start()
    active.client.emitText(frame())
    await vi.waitFor(() => { expect(active.calls).toContain('followup') })
    await active.runtime.close()
    expect(active.calls).toContain('cancel')

    const client = new Client()
    client.connectError = new Error('connect failed')
    const failed = harness({ client })
    await expect(failed.runtime.start()).rejects.toThrow('connect failed')
  })
})
