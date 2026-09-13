import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from '../src/config.ts'
import { WeComScheduledActions, resolveScheduledActions } from '../src/scheduled-actions.ts'

class Table<T> {
  readonly records = new Map<string, T>()
  putFailure: unknown
  beforePut: (() => Promise<void>) | undefined
  get(key: string): T | undefined { return this.records.get(key) }
  entries(): IterableIterator<[string, T]> { return new Map(this.records).entries() }
  async put(key: string, value: T): Promise<void> {
    await this.beforePut?.()
    if (this.putFailure !== undefined) throw this.putFailure
    this.records.set(key, value)
  }
  async delete(key: string): Promise<boolean> { return this.records.delete(key) }
}

interface ActionRecord {
  sessionId: string
  conversationKey: string
  actionId: string
  definitionFingerprint: string
  target: string
  runAt: number
  state: 'pending' | 'running'
  createdAt: number
  updatedAt: number
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    botId: 'bot', secretEnv: 'secret', sessionKeyEnv: 'identity', workspacePath: '/workspace',
    agentPreset: 'standard', permissionPreset: 'wecom', groupConversationMode: 'shared',
    allowedUsers: ['user'], allowedChats: [], sessionTitlePrefix: 'WeCom', connectTimeoutMs: 1_000,
    streamFlushIntervalMs: 1, maxInputBytes: 1_000, maxReplyBytes: 20_480, turnTimeoutMs: 10_000,
    deliveryRetentionMs: 10_000, maxDeliveryRecords: 100, outboxRetryIntervalMs: 10_000,
    maxOutboxAttempts: 3, maxScheduledActionsPerConversation: 2,
    maxScheduledActionDelayMs: 86_400_000, scheduledActionTimeoutMs: 10_000,
    scheduledActionUtcOffset: '+08:00',
    scheduledActions: [{
      id: 'ps_check', description: 'Run the read-only process check.', toolName: 'quick',
      targetArgument: 'colos', targetArgumentFormat: 'singleton-array',
      targetPattern: '^[a-z0-9-]+$', arguments: { command: 'check' },
    }],
    messages: {
      processing: 'processing', timeout: 'timeout', failure: 'failure', emptyReply: 'empty',
      unauthorized: 'unauthorized', duplicate: 'duplicate', scheduledActionSuccess: 'success',
      scheduledActionFailure: 'failure', scheduledActionUncertain: 'uncertain',
      scheduledActionDefinitionUnavailable: 'definition changed',
    },
    ...overrides,
  }
}

const contexts: Context[] = []

async function harness(options: {
  shared?: { actions: Table<ActionRecord>; conversations: Table<Record<string, unknown>> }
  configured?: ResolvedConfig
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const stores = options.shared ?? { actions: new Table<ActionRecord>(), conversations: new Table<Record<string, unknown>>() }
  stores.conversations.records.set('conversation', {
    sessionId: 'session', target: 'wecom-user', chatType: 'single', updatedAt: Date.now(),
  })
  const notifications: Array<{ target: string; content: string }> = []
  const scheduled = new WeComScheduledActions(ctx, {
    config: options.configured ?? config(),
    conversations: { table: () => stores.conversations } as never,
    actions: { table: () => stores.actions } as never,
    enqueueNotification: async (target, content) => { notifications.push({ target, content }) },
  })
  const agent = { session: { id: 'session' } } as Agent
  scheduled.register(ctx, agent, 'conversation')
  return { ctx, stores, scheduled, agent, notifications }
}

async function call(test: Awaited<ReturnType<typeof harness>>, name: string, argumentsValue: unknown) {
  return test.ctx.tools.execute({
    callId: ToolCallId(`${name}-${Math.random()}`), name, arguments: argumentsValue,
    agent: test.agent, signal: new AbortController().signal,
  })
}

interface ScheduledActionInternals {
  arm(id: string, runAt: number): void
  dispatch(id: string): Promise<void>
}

function internals(scheduled: WeComScheduledActions): ScheduledActionInternals {
  return scheduled as unknown as ScheduledActionInternals
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-12T04:00:00.000Z'))
})

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
})

describe('WeCom scheduled actions', () => {
  it('validates the deployment-owned allowlist before opening storage', () => {
    const valid = config().scheduledActions[0]!
    for (const invalid of [
      { ...valid, id: 'bad id' },
      { ...valid, description: ' ' },
      { ...valid, toolName: ' ' },
      { ...valid, targetArgument: 'bad-key' },
      { ...valid, targetArgumentFormat: 'many-arrays' },
      { ...valid, targetPattern: '[' },
      { ...valid, arguments: null },
      { ...valid, arguments: [] },
      { ...valid, arguments: () => undefined },
    ]) expect(() => resolveScheduledActions([invalid as never])).toThrow()
    const { arguments: _arguments, ...withoutArguments } = valid
    expect(resolveScheduledActions([withoutArguments]).size).toBe(1)
    expect(() => resolveScheduledActions([
      { ...valid, targetPattern: 'unanchored' },
    ])).toThrow(/anchored/)
    expect(() => resolveScheduledActions([
      valid, valid,
    ])).toThrow(/duplicates/)
    expect(() => resolveScheduledActions([
      { ...valid, arguments: { colos: ['forged'] } },
    ])).toThrow(/must not define targetArgument/)
  })

  it('does not expose management tools when the action allowlist is empty', async () => {
    const test = await harness({ configured: config({ scheduledActions: [] }) })
    expect(test.ctx.tools.get('scheduled_action_create')).toBeUndefined()
    await test.scheduled.close()
    internals(test.scheduled).arm('closed', Date.now() + 1_000)
  })

  it('accepts every supported offset form and rejects malformed calendar and offset fields', async () => {
    const test = await harness()
    await test.scheduled.start()
    await test.scheduled.start()
    for (const at of [
      '2026-09-12T05:00:00Z',
      '2026-09-12T13:00:00.1+08:00',
      '2026-09-12T03:00:00-02:00',
      '13:00',
      '13:00:01',
      '11:59',
    ]) {
      const created = await call(test, 'scheduled_action_create', { action: 'ps_check', target: 'cf-sh-2', at })
      expect(created.value).toHaveProperty('id')
      await call(test, 'scheduled_action_delete', { id: (created.value as { id: string }).id })
    }
    for (const at of [
      'not-a-time', '2026-00-12T05:00:00Z', '2026-13-12T05:00:00Z',
      '2026-09-12T24:00:00Z', '2026-09-12T05:60:00Z', '2026-09-12T05:00:60Z',
      '2026-02-30T05:00:00Z', '2026-09-12T05:00:00+24:00', '2026-09-12T05:00:00+08:60',
      '24:00', '12:60', '12:00:60',
    ]) {
      const rejected = await call(test, 'scheduled_action_create', { action: 'ps_check', target: 'cf-sh-2', at })
      expect(rejected.value).toHaveProperty('code', 'invalid_time')
    }
    const tooFar = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: new Date(Date.now() + 86_400_001).toISOString(),
    })
    expect(tooFar.value).toHaveProperty('code', 'time_out_of_range')
    const utc = await harness({ configured: config({ scheduledActionUtcOffset: 'Z' }) })
    await utc.scheduled.start()
    const utcCreated = await call(utc, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '05:00',
    })
    expect(utcCreated.value).toHaveProperty('runAt', '2026-09-12T05:00:00.000Z')
    await utc.scheduled.close()
    const negative = await harness({ configured: config({ scheduledActionUtcOffset: '-02:00' }) })
    await negative.scheduled.start()
    const negativeCreated = await call(negative, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '05:00',
    })
    expect(negativeCreated.value).toHaveProperty('runAt', '2026-09-12T07:00:00.000Z')
    await negative.scheduled.close()
    await test.scheduled.close()
    const cancelled = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: new Date(Date.now() + 1_000).toISOString(),
    })
    expect(cancelled.value).toHaveProperty('code', 'cancelled')
  })

  it('persists a future action, runs it only when due through policy, and notifies WeCom', async () => {
    const test = await harness()
    const bodies: unknown[] = []
    const policy: string[] = []
    test.ctx.on('tools/pre-execute', (exec, next) => { policy.push(exec.name); return next() })
    test.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: {
        command: { type: 'string' }, colos: { type: 'array', items: { type: 'string' } },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { bodies.push(args); return 'process snapshot' },
    }))
    await test.scheduled.start()
    const created = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    expect(created.isError).toBe(false)
    expect(test.stores.actions.records.size).toBe(1)
    expect(bodies).toEqual([])

    await vi.advanceTimersByTimeAsync(59_999)
    expect(bodies).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() => { expect(test.notifications).toHaveLength(1) })

    expect(bodies).toEqual([{ command: 'check', colos: ['cf-sh-2'] }])
    expect(policy).toEqual(['scheduled_action_create', 'quick'])
    expect(test.notifications[0]).toMatchObject({ target: 'wecom-user' })
    expect(test.notifications[0]?.content).toContain('success')
    expect(test.notifications[0]?.content).toContain('process snapshot')
    expect(test.stores.actions.records.size).toBe(0)
    await test.scheduled.close()
  })

  it('defaults to a scalar target argument for tools that do not require an array', async () => {
    const configuredAction = config().scheduledActions[0]!
    const { targetArgumentFormat: _arrayFormat, ...scalarAction } = configuredAction
    const test = await harness({ configured: config({
      scheduledActions: [{ ...scalarAction, targetArgument: 'colo' }],
    }) })
    const bodies: unknown[] = []
    test.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: {
        command: { type: 'string' }, colo: { type: 'string' },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) { bodies.push(args); return 'ok' },
    }))
    await test.scheduled.start()
    await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-1', at: new Date(Date.now() + 1_000).toISOString(),
    })
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => { expect(bodies).toEqual([{ command: 'check', colo: 'cf-sh-1' }]) })
    await test.scheduled.close()
  })

  it('recovers pending work after restart and never repeats an in-flight side effect', async () => {
    const first = await harness()
    await first.scheduled.start()
    await call(first, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-1', at: '2026-09-12T12:01:00+08:00',
    })
    await first.scheduled.close()
    const second = await harness({ shared: first.stores })
    let executions = 0
    second.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: { command: { type: 'string' }, colo: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { executions += 1; return 'ok' },
    }))
    await second.scheduled.start()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(executions).toBe(1) })
    await second.scheduled.close()

    const uncertain = await harness()
    uncertain.stores.actions.records.set('running', {
      sessionId: 'session', conversationKey: 'conversation', actionId: 'ps_check',
      definitionFingerprint: 'unknown-after-crash', target: 'cf-sh-1', runAt: Date.now(),
      state: 'running', createdAt: Date.now(), updatedAt: Date.now(),
    })
    await uncertain.scheduled.start()
    expect(uncertain.notifications[0]?.content).toContain('uncertain')
    expect(uncertain.stores.actions.records.size).toBe(0)
    await uncertain.scheduled.close()
  })

  it('rejects unsafe times and targets and serializes cancellation against dispatch', async () => {
    const test = await harness()
    await test.scheduled.start()
    for (const input of [
      { action: 'ps_check', target: 'cf sh 2', at: '2026-09-12T12:01:00+08:00' },
      { action: 'ps_check', target: 'cf-sh-2', at: '2026-02-30T12:01:00+08:00' },
      { action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T03:59:00Z' },
    ]) {
      const result = await call(test, 'scheduled_action_create', input)
      expect(result.isError).toBe(false)
      expect(result.value).toHaveProperty('code')
    }
    const created = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    const id = (created.value as { id: string }).id
    const deleted = await call(test, 'scheduled_action_delete', { id })
    expect(deleted.value).toEqual({ id, deleted: true })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(test.notifications).toEqual([])
    await test.scheduled.close()
  })

  it('enforces per-conversation limits and owner-only list and delete operations', async () => {
    const test = await harness({ configured: config({ maxScheduledActionsPerConversation: 2 }) })
    await test.scheduled.start()
    const first = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:02:00+08:00',
    })
    const second = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-1', at: '2026-09-12T12:03:00+08:00',
    })
    const limited = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-3', at: '2026-09-12T12:04:00+08:00',
    })
    expect(limited.value).toHaveProperty('code', 'schedule_limit')
    test.stores.actions.records.set('foreign', {
      ...(test.stores.actions.records.values().next().value as ActionRecord), sessionId: 'other', createdAt: 0,
    })
    const listed = await call(test, 'scheduled_action_list', {})
    expect(listed.value).toHaveLength(2)
    expect((listed.value as Array<{ id: string }>).map(item => item.id)).toEqual([
      (first.value as { id: string }).id, (second.value as { id: string }).id,
    ])
    expect(await call(test, 'scheduled_action_delete', { id: 'missing' })).toHaveProperty('value.deleted', false)
    expect(await call(test, 'scheduled_action_delete', { id: 'foreign' })).toHaveProperty('value.deleted', false)
    const id = (first.value as { id: string }).id
    const running = test.stores.actions.records.get(id)!
    test.stores.actions.records.set(id, { ...running, state: 'running' })
    expect(await call(test, 'scheduled_action_list', {})).toHaveProperty('value.0.state', 'running')
    expect(await call(test, 'scheduled_action_delete', { id })).toHaveProperty('value.code', 'already_running')
    test.stores.actions.records.set('untimed', { ...running, state: 'pending' })
    expect(await call(test, 'scheduled_action_delete', { id: 'untimed' })).toHaveProperty('value.deleted', true)
    await test.scheduled.close()
  })

  it('reports dispatch-time policy denial and definition drift without invoking the tool', async () => {
    const denied = await harness()
    denied.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: { command: { type: 'string' }, colo: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'must not run' },
    }))
    denied.ctx.on('tools/pre-execute', async exec => exec.name === 'quick'
      ? { kind: 'deny', reason: 'dispatch policy denied' }
      : { kind: 'allow' })
    await denied.scheduled.start()
    await call(denied, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(denied.notifications).toHaveLength(1) })
    expect(denied.notifications[0]?.content).toContain('dispatch policy denied')
    expect(denied.notifications[0]?.content).toContain('failure')
    await denied.scheduled.close()

    const initial = await harness()
    await initial.scheduled.start()
    await call(initial, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:02:00+08:00',
    })
    await initial.scheduled.close()
    const changed = config({ scheduledActions: [{
      ...config().scheduledActions[0]!, arguments: { command: 'different' },
    }] })
    const restarted = await harness({ shared: initial.stores, configured: changed })
    await restarted.scheduled.start()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(restarted.notifications).toHaveLength(1) })
    expect(restarted.notifications[0]?.content).toContain('definition changed')
    await restarted.scheduled.close()
  })

  it('contains persistence failures and logs background dispatch failures', async () => {
    const test = await harness()
    await test.scheduled.start()
    test.stores.actions.putFailure = new Error('create write failed')
    const rejected = await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    expect(rejected.isError).toBe(true)
    test.stores.actions.putFailure = undefined
    for (const at of ['2026-09-12T12:01:00+08:00', '2026-09-12T12:02:00+08:00']) {
      await call(test, 'scheduled_action_create', { action: 'ps_check', target: 'cf-sh-2', at })
    }
    const warn = vi.spyOn(test.ctx.logger, 'warn')
    test.stores.actions.putFailure = new Error('dispatch write failed')
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('dispatch write failed')) })
    test.stores.actions.putFailure = 'string failure'
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith(expect.stringContaining('string failure')) })
    test.stores.actions.putFailure = undefined
    await test.scheduled.close()
  })

  it('leaves a claimed action for uncertain recovery when shutdown aborts its tool', async () => {
    const test = await harness()
    const entered = Promise.withResolvers<undefined>()
    test.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: { command: { type: 'string' }, colo: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, exec) => {
        entered.resolve(undefined)
        return new Promise<string>((resolve) => {
          exec.signal.addEventListener('abort', () => { resolve('aborted') }, { once: true })
        })
      },
    }))
    await test.scheduled.start()
    await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    vi.advanceTimersByTime(60_000)
    await entered.promise
    await test.scheduled.close()
    expect([...test.stores.actions.records.values()][0]?.state).toBe('running')
    expect(test.notifications).toEqual([])
  })

  it('removes completed work quietly when its conversation disappeared', async () => {
    const test = await harness()
    test.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: { command: { type: 'string' }, colo: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return 'ok' },
    }))
    await test.scheduled.start()
    await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    test.stores.conversations.records.delete('conversation')
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(test.stores.actions.records.size).toBe(0) })
    expect(test.notifications).toEqual([])
    await test.scheduled.close()
  })

  it('omits non-text tool blocks from the active-send detail', async () => {
    const test = await harness()
    test.ctx.tools.register(defineTool({
      name: 'quick', description: 'quick', parameters: { command: { type: 'string' }, colo: { type: 'string' } },
      output: {
        schema: { type: 'string' },
        render: () => [{ type: 'image', attachment: {} as never }],
      },
      async execute() { return 'image' },
    }))
    await test.scheduled.start()
    await call(test, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: '2026-09-12T12:01:00+08:00',
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => { expect(test.notifications).toHaveLength(1) })
    expect(test.notifications[0]?.content).toBe('success\n\n`ps_check` @ `cf-sh-2`\n\n')
    await test.scheduled.close()
  })

  it('keeps missing conversations quiet and segments timers beyond the platform delay', async () => {
    const farConfig = config({ maxScheduledActionDelayMs: 3_000_000_000 })
    const test = await harness({ configured: farConfig })
    test.stores.conversations.records.delete('conversation')
    test.stores.actions.records.set('running', {
      sessionId: 'session', conversationKey: 'conversation', actionId: 'ps_check',
      definitionFingerprint: 'fingerprint', target: 'cf-sh-1', runAt: Date.now(), state: 'running',
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    await test.scheduled.start()
    expect(test.notifications).toEqual([])
    await internals(test.scheduled).dispatch('missing')
    test.stores.actions.records.set('already-running', {
      sessionId: 'session', conversationKey: 'conversation', actionId: 'ps_check',
      definitionFingerprint: 'fingerprint', target: 'cf-sh-1', runAt: Date.now(), state: 'running',
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    await internals(test.scheduled).dispatch('already-running')
    const closed = await harness({ configured: farConfig })
    await closed.scheduled.start()
    await call(closed, 'scheduled_action_create', {
      action: 'ps_check', target: 'cf-sh-2', at: new Date(Date.now() + 2_147_483_648).toISOString(),
    })
    await vi.advanceTimersByTimeAsync(2_147_483_647)
    expect(closed.stores.actions.records.size).toBe(1)
    await closed.scheduled.close()
  })
})
