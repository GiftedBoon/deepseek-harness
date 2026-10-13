/** Executable schedules exercise durable admission, coalescing, and scoped state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { harness, agentFor } from './harness.ts'
import { registerTaskTools } from '../src/task-tools.ts'
import { scheduleExecutionDomain } from '../src/task-storage.ts'
import { renderTaskFraming } from '../src/task-runtime.ts'
import { hostTaskExecutor } from '../src/task-executor.ts'
import type { ScheduleExecution, ScheduleExecutionId } from '../src/types.ts'
import { MemoryMediaPool } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ScheduleId } from '../src/domain.ts'

const tests: Awaited<ReturnType<typeof harness>>[] = []
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-12T15:39:00Z')) })
afterEach(async () => { await Promise.all(tests.splice(0).map(test => test.ctx.fiber.dispose())); vi.useRealTimers() })
async function setup(options: Parameters<typeof harness>[0] = {}) { const test = await harness(options); tests.push(test); return test }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve() }

describe('scheduled execution', () => {
  it('persists executable ownership before due admission and lets executing work create sibling tasks', async () => {
    const test = await setup()
    const sessionId = SessionId('owner')
    const run = vi.fn(async (execution: ScheduleExecution) => {
      expect(await test.service.executions({ sessionId, limit: 10 })).toMatchObject([{ id: execution.id, status: 'running', providerId: 'fixture' }])
      await test.service.createTask(sessionId, { title: 'Sibling', prompt: 'Later', after_seconds: 60 })
      await test.service.writeState(sessionId, 'night', 0, { run_id: 'readonly-1' })
      return { status: 'completed' as const, inputMessageId: execution.inputMessageId, output: 'Tool result: finished' }
    })
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId, execute: run }))
    await test.service.createTask(sessionId, { title: 'Check', prompt: 'Call check_daily_preopen', after_seconds: 1 })
    expect(await test.service.list({ sessionId })).toEqual([])
    expect(await test.service.listTasks({ sessionId })).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    await settle()
    expect(run).toHaveBeenCalledTimes(1)
    expect((await test.service.executions({ sessionId, limit: 10 }))[0]).toMatchObject({ status: 'completed', output: 'Tool result: finished' })
    expect(await test.service.readState(sessionId, 'night')).toEqual({ workflow: 'night', revision: 1, value: { run_id: 'readonly-1' } })
    expect(await test.service.listTasks({ sessionId })).toMatchObject([{ title: 'Sibling' }])
    expect(test.resolve).not.toHaveBeenCalled()
  })

  it('coalesces pending minute runs to one latest occurrence while the Session is busy', async () => {
    const test = await setup({ config: { taskExecutionRecords: 1 } })
    const sessionId = SessionId('busy')
    const release = Promise.withResolvers<undefined>()
    const run = vi.fn(async () => { await release.promise; return { status: 'completed' as const } })
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId, execute: run }))
    await test.service.createTask(sessionId, { title: 'Minute', prompt: 'Check', every_seconds: 60 })
    try {
      await vi.advanceTimersByTimeAsync(180000)
      const values = await test.service.executions({ sessionId, limit: 10 })
      expect(values).toHaveLength(2)
      expect(values).toMatchObject([{ status: 'queued', scheduledAt: '2026-10-12T15:42:00.000Z' }, { status: 'running', scheduledAt: '2026-10-12T15:40:00.000Z' }])
      expect(run).toHaveBeenCalledTimes(1)
    } finally { release.resolve(undefined); await settle() }
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(0)
    expect(await test.service.executions({ sessionId, limit: 10 })).toMatchObject([{ status: 'completed' }])
    expect(await test.service.executions({ sessionId, limit: 10 })).toHaveLength(1)
  })

  it('keeps cold provider identity and never replays uncertain running work', async () => {
    const pool = new MemoryMediaPool()
    const sessionId = SessionId('cold')
    const old: ScheduleExecution = { providerId: 'wecom', id: 'execution-old' as ScheduleExecutionId, scheduleId: ScheduleId('task-old'), sessionId,
      title: 'Prior', prompt: 'Do it', scheduledAt: '2026-10-12T15:38:00.000Z', createdAt: '2026-10-12T15:38:00.000Z', status: 'running', inputMessageId: MessageId('old-input') }
    const test = await setup({ pool, beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleExecutionDomain)
      await domain.table('executions').put(old.id, old)
      await domain.close()
    } })
    const run = vi.fn(async () => ({ status: 'completed' as const }))
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'wecom', accepts: id => id === sessionId, execute: run }))
    await settle()
    expect((await test.service.executions({ sessionId, limit: 10 }))[0]).toMatchObject({ status: 'interrupted', inputMessageId: 'old-input' })
    expect(run).not.toHaveBeenCalled()
    const agent = agentFor(test.ctx, 'cold')
    const message = { id: old.inputMessageId, role: 'user' as const, source: { kind: 'schedule' as const }, content: [{ type: 'text' as const, text: 'Do it' }] }
    const decision = await test.ctx.waterfall('agent/pre-step', { agent, messages: [message], turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages: [message] }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('does not fall back to the Host when its persisted adapter is unavailable', async () => {
    const test = await setup()
    const sessionId = SessionId('adapter')
    const remove = test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId, execute: async () => ({ status: 'completed' }) })
    const record = await test.service.createTask(sessionId, { title: 'Special', prompt: 'Check', after_seconds: 1 })
    remove()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await test.service.executions({ sessionId, id: record.id, limit: 1 })).toMatchObject([{ status: 'queued', providerId: 'fixture' }])
    expect(test.resolve).not.toHaveBeenCalled()
    await test.service.delete({ sessionId, id: record.id })
    expect(await test.service.executions({ sessionId, limit: 1 })).toMatchObject([{ status: 'interrupted' }])
  })

  it('retains failed input suppression after history pruning and a Host restart', async () => {
    const pool = new MemoryMediaPool()
    const sessionId = SessionId('pruned-input')
    const test = await setup({ pool, config: { taskExecutionRecords: 1 } })
    const inputs: MessageId[] = []
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId,
      execute: async (execution) => { inputs.push(execution.inputMessageId); return { status: 'failed', error: 'Uncertain input settlement' } } }))
    const task = await test.service.createTask(sessionId, { title: 'Minute', prompt: 'Check', every_seconds: 60 })
    await vi.advanceTimersByTimeAsync(240000)
    expect(inputs).toHaveLength(4)
    expect(await test.service.executions({ sessionId, limit: 10 })).toHaveLength(1)
    await test.service.delete({ sessionId, id: task.id })
    await test.ctx.fiber.dispose()
    const reopened = await setup({ pool, config: { taskExecutionRecords: 1 } })
    const agent = agentFor(reopened.ctx, sessionId)
    const messages = inputs.map(id => ({ id, role: 'user' as const, source: { kind: 'schedule' as const }, content: [{ type: 'text' as const, text: 'Check' }] }))
    const decision = await reopened.ctx.waterfall('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    expect(pool.media.get('schedule_execution')?.tables.get('blocked_inputs')?.size).toBe(4)
  })

  it('backfills terminal input suppression before recovery prunes older history', async () => {
    const pool = new MemoryMediaPool()
    const sessionId = SessionId('recovery-prune')
    const inputIds = [MessageId('failed-old'), MessageId('failed-new'), MessageId('crash-newest')]
    const test = await setup({ pool, config: { taskExecutionRecords: 1 }, beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleExecutionDomain)
      for (const [index, inputMessageId] of inputIds.entries()) {
        const id = `execution-${index}` as ScheduleExecutionId
        await domain.table('executions').put(id, { id, providerId: 'host', scheduleId: ScheduleId('old-task'), sessionId,
          title: 'Check', prompt: 'Check', inputMessageId, scheduledAt: '2026-10-12T15:38:00.000Z',
          createdAt: `2026-10-12T15:38:0${index}.000Z`, status: index === 2 ? 'running' : 'failed' })
      }
      await domain.close()
    } })
    expect(await test.service.executions({ sessionId, limit: 10 })).toMatchObject([{ inputMessageId: 'crash-newest', status: 'interrupted', interruptionReason: 'crash' }])
    expect(pool.media.get('schedule_execution')?.tables.get('blocked_inputs')?.size).toBe(3)
    const agent = agentFor(test.ctx, sessionId)
    const messages = inputIds.map(id => ({ id, role: 'user' as const, source: { kind: 'schedule' as const }, content: [{ type: 'text' as const, text: 'Check' }] }))
    const decision = await test.ctx.waterfall('agent/pre-step', { agent, messages, turn: 1, step: 1, signal: new AbortController().signal }, async () => ({ kind: 'enter' as const, messages }))
    expect(decision).toEqual({ kind: 'enter', messages: [] })
  })

  it('serializes CAS, preserves tombstones, and bounds complete multibyte records', async () => {
    const test = await setup({ config: { taskStateBytes: 256, taskWorkflowLimit: 1 } })
    const sessionId = SessionId('state')
    const results = await Promise.all([test.service.writeState(sessionId, 'night', 0, { done: true }), test.service.writeState(sessionId, 'night', 0, { done: false })])
    expect(results[0]).toEqual({ workflow: 'night', revision: 1, value: { done: true } })
    expect(results[1]).toMatchObject({ code: 'state_conflict', current: { revision: 1 } })
    const detached = await test.service.readState(sessionId, 'night')
    if (typeof detached.value === 'object' && detached.value !== null && !Array.isArray(detached.value)) detached.value.done = false
    expect(await test.service.readState(sessionId, 'night')).toMatchObject({ revision: 1, value: { done: true } })
    await expect(test.service.writeState(sessionId, 'night', 1, { message: '汉'.repeat(100) })).rejects.toMatchObject({ code: 'invalid_rule' })
    await expect(test.service.writeState(sessionId, 'other', 0, null)).rejects.toMatchObject({ code: 'invalid_rule' })
    expect(await test.service.readState(SessionId('different'), 'night')).toEqual({ workflow: 'night', revision: 0, value: null })
    expect(await test.service.writeState(sessionId, 'night', 1, null)).toEqual({ workflow: 'night', revision: 2, value: null })
  })

  it('expires queued work at the cutoff and stops recurrence even when the adapter is unavailable', async () => {
    const test = await setup()
    const sessionId = SessionId('expiry')
    const remove = test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId, execute: async () => ({ status: 'completed' }) })
    const record = await test.service.createTask(sessionId, { title: 'Minute', prompt: 'Check', every_seconds: 60, expires_at: '2026-10-12T23:41:30+08:00' })
    expect(record.expiresAt).toBe('2026-10-12T15:41:30.000Z')
    remove()
    await vi.advanceTimersByTimeAsync(90000)
    expect(await test.service.executions({ sessionId, limit: 10 })).toMatchObject([{ status: 'queued', expiresAt: record.expiresAt }])
    await vi.advanceTimersByTimeAsync(60000)
    expect(await test.service.listTasks({ sessionId })).toEqual([])
    expect(await test.service.executions({ sessionId, limit: 10 })).toMatchObject([{ status: 'interrupted', interruptionReason: 'expired' }])
    expect(await test.service.catalog()).toMatchObject([{ status: 'inactive', purpose: 'task', expiresAt: record.expiresAt }])
    const run = vi.fn(async () => ({ status: 'completed' as const }))
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId, execute: run }))
    await vi.advanceTimersByTimeAsync(60000)
    expect(run).not.toHaveBeenCalled()
    await expect(test.service.createTask(sessionId, { title: 'Invalid', prompt: 'Check', after_seconds: 60, expires_at: '2026-10-12T23:43:30+08:00' })).rejects.toMatchObject({ code: 'invalid_rule' })
  })

  it('bounds complete failure settlements without leaving oversized output running', async () => {
    const test = await setup({ config: { taskExecutionBytes: 4096 } })
    const sessionId = SessionId('oversized')
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId,
      execute: async () => { throw new Error('汉'.repeat(6000)) } }))
    await test.service.createTask(sessionId, { title: 'Large error', prompt: 'Check', after_seconds: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    const [execution] = await test.service.executions({ sessionId, limit: 1 })
    expect(execution!.status).toBe('failed')
    expect(Buffer.byteLength(JSON.stringify(execution))).toBeLessThanOrEqual(4096)
    expect(execution!.error).toContain('Error: 汉')
  })

  it('records oversized successful output as a bounded failure instead of truncating the result', async () => {
    const test = await setup({ config: { taskExecutionBytes: 4096 } })
    const sessionId = SessionId('oversized-output')
    test.ctx.effect(() => test.service.registerTaskExecutor({ id: 'fixture', accepts: id => id === sessionId,
      execute: async () => ({ status: 'completed', output: '汉'.repeat(6000) }) }))
    await test.service.createTask(sessionId, { title: 'Large output', prompt: 'Check', after_seconds: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    const [execution] = await test.service.executions({ sessionId, limit: 1 })
    expect(execution).toMatchObject({ status: 'failed', error: 'Error: Scheduled result exceeds the configured byte limit' })
    expect(execution!.output).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(execution))).toBeLessThanOrEqual(4096)
  })

  it('rejects exhausted state revisions without changing durable JSON', async () => {
    const sessionId = SessionId('exhausted')
    const test = await setup({ beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleExecutionDomain)
      await domain.table('states').put(JSON.stringify([sessionId, 'night']), { sessionId, workflow: 'night', revision: Number.MAX_SAFE_INTEGER, value: { done: true } })
      await domain.close()
    } })
    await expect(test.service.writeState(sessionId, 'night', Number.MAX_SAFE_INTEGER, null)).rejects.toMatchObject({ code: 'invalid_rule' })
    expect(await test.service.readState(sessionId, 'night')).toMatchObject({ revision: Number.MAX_SAFE_INTEGER, value: { done: true } })
  })

  it('rejects persisted workflow keys that could expose another Session state', async () => {
    const sessionId = SessionId('foreign-state')
    let failedContext: Context | undefined
    try {
      await expect(setup({ onContext: (ctx) => { failedContext = ctx }, beforeService: async (_ctx, facility) => {
        const domain = await facility.open(scheduleExecutionDomain)
        await domain.table('states').put(JSON.stringify([SessionId('reader'), 'night']), { sessionId, workflow: 'night', revision: 1, value: { private: true } })
        await domain.close()
      } })).rejects.toThrow('workflow key differs from its stored Session and workflow')
    } finally { await failedContext?.fiber.dispose() }
  })

  it.each(['queued', 'running'])('rejects a cold %s execution without its input identity', async (status) => {
    const pool = new MemoryMediaPool()
    pool.versions.set('schedule_execution', 1)
    pool.media.set('schedule_execution', { global: null, tables: new Map([['executions', new Map([['broken', {
      providerId: 'host', id: 'broken', scheduleId: 'task', sessionId: 'session', title: 'Check', prompt: 'Check',
      scheduledAt: '2026-10-12T15:39:00.000Z', createdAt: '2026-10-12T15:39:00.000Z', status,
    }]])]]) })
    let failedContext: Context | undefined
    try {
      await expect(setup({ pool, onContext: (ctx) => { failedContext = ctx } })).rejects.toThrow("stored record 'broken' in table 'executions' does not match its schema")
    } finally { await failedContext?.fiber.dispose() }
  })

  it.each([
    { kind: 'key', expected: 'execution key differs from its stored id' },
    { kind: 'input', expected: 'execution input identity is shared by multiple executions' },
    { kind: 'blocked-owner', expected: 'blocked input owner differs from its execution Session' },
    { kind: 'adapter', expected: 'execution owner differs from its task adapter and Session' },
  ])('rejects cold $kind execution corruption', async ({ kind, expected }) => {
    let failedContext: Context | undefined
    try {
      await expect(setup({ onContext: (ctx) => { failedContext = ctx }, beforeService: async (_ctx, facility) => {
        const domain = await facility.open(scheduleExecutionDomain)
        const id = 'execution-valid' as ScheduleExecutionId
        const execution: ScheduleExecution = { id, providerId: 'host', scheduleId: ScheduleId('task'), sessionId: SessionId('owner'),
          title: 'Check', prompt: 'Check', inputMessageId: MessageId('input'), scheduledAt: '2026-10-12T15:38:00.000Z', createdAt: '2026-10-12T15:38:00.000Z', status: 'queued' }
        await domain.table('executions').put(kind === 'key' ? 'different' as ScheduleExecutionId : id, execution)
        if (kind === 'input') await domain.table('executions').put('second' as ScheduleExecutionId, { ...execution, id: 'second' as ScheduleExecutionId })
        if (kind === 'blocked-owner') await domain.table('blocked_inputs').put(execution.inputMessageId, SessionId('foreign'))
        if (kind === 'adapter') await domain.table('owners').put(execution.scheduleId, { sessionId: execution.sessionId, providerId: 'wecom' })
        await domain.close()
      } })).rejects.toThrow(expected)
    } finally { await failedContext?.fiber.dispose() }
  })

  it.each([
    { workflow: ' night ', revision: 1 },
    { workflow: 'night', revision: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid persisted workflow fields $workflow $revision', async ({ workflow, revision }) => {
    const pool = new MemoryMediaPool()
    pool.versions.set('schedule_execution', 1)
    pool.media.set('schedule_execution', { global: null, tables: new Map([['states', new Map([['invalid', {
      sessionId: 'owner', workflow, revision, value: null,
    }]])]]) })
    let failedContext: Context | undefined
    try {
      await expect(setup({ pool, onContext: (ctx) => { failedContext = ctx } })).rejects.toThrow("stored record 'invalid' in table 'states' does not match its schema")
    } finally { await failedContext?.fiber.dispose() }
  })

  it('pages retained executions beyond one hundred without crossing Session ownership', async () => {
    const sessionId = SessionId('history')
    const test = await setup({ beforeService: async (_ctx, facility) => {
      const domain = await facility.open(scheduleExecutionDomain)
      for (let index = 0; index < 205; index++) {
        const id = `execution-${String(index).padStart(3, '0')}` as ScheduleExecutionId
        await domain.table('executions').put(id, { id, providerId: 'host', scheduleId: ScheduleId(`task-${index % 2}`), sessionId,
          title: 'Check', prompt: 'Check', inputMessageId: MessageId(`input-${index}`),
          scheduledAt: '2026-10-12T15:38:00.000Z', createdAt: '2026-10-12T15:38:00.000Z', status: 'completed' })
      }
      await domain.close()
    } })
    const first = await test.service.executions({ sessionId, limit: 100 })
    const second = await test.service.executions({ sessionId, limit: 100, before: first[99]!.id })
    const third = await test.service.executions({ sessionId, limit: 100, before: second[99]!.id })
    expect([first.length, second.length, third.length]).toEqual([100, 100, 5])
    expect(new Set([...first, ...second, ...third].map(value => value.id)).size).toBe(205)
    expect(first[0]?.id).toBe('execution-204')
    expect(await test.service.executions({ sessionId, limit: 100, before: third[4]!.id })).toEqual([])
    await expect(test.service.executions({ sessionId: SessionId('foreign'), limit: 100, before: first[99]!.id })).rejects.toMatchObject({ code: 'invalid_rule' })
    await expect(test.service.executions({ sessionId, id: ScheduleId('task-1'), limit: 100, before: first[0]!.id })).rejects.toMatchObject({ code: 'invalid_rule' })
  })

  it('waits for human work without cancelling it when scheduled execution unloads', async () => {
    const test = await setup()
    const base = agentFor(test.ctx, 'human')
    const entered = Promise.withResolvers<undefined>()
    const idle = Promise.withResolvers<undefined>()
    const agent = { ...base, status: 'running' as const, whenIdle: async () => { entered.resolve(undefined); await idle.promise } }
    const cancel = vi.spyOn(agent, 'cancel')
    test.resolve.mockResolvedValue({ agent })
    const controller = new AbortController()
    const execution: ScheduleExecution = { providerId: 'host', id: 'waiting' as ScheduleExecutionId, scheduleId: ScheduleId('human-task'), sessionId: agent.session.id,
      title: 'Check', prompt: 'Read state', scheduledAt: '2026-10-12T15:40:00.000Z', createdAt: '2026-10-12T15:40:00.000Z', status: 'running', inputMessageId: MessageId('human-task-input') }
    const running = hostTaskExecutor(test.ctx).execute(execution, controller.signal)
    await entered.promise
    const rejected = expect(running).rejects.toThrow('unload')
    controller.abort('unload')
    await rejected
    expect(agent.followup).not.toHaveBeenCalled()
    expect(cancel).not.toHaveBeenCalled()
    idle.resolve(undefined)
  })

  it('rechecks expiry after the existing human turn settles', async () => {
    const test = await setup()
    const base = agentFor(test.ctx, 'late')
    const entered = Promise.withResolvers<undefined>()
    const idle = Promise.withResolvers<undefined>()
    const agent = { ...base, status: 'running' as const, whenIdle: async () => { entered.resolve(undefined); await idle.promise } }
    test.resolve.mockResolvedValue({ agent })
    const execution: ScheduleExecution = { providerId: 'host', id: 'late' as ScheduleExecutionId, scheduleId: ScheduleId('late-task'), sessionId: agent.session.id,
      title: 'Check', prompt: 'Read state', scheduledAt: '2026-10-12T15:39:00.000Z', expiresAt: '2026-10-12T15:40:00.000Z', createdAt: '2026-10-12T15:39:00.000Z', status: 'running', inputMessageId: MessageId('late-input') }
    const running = hostTaskExecutor(test.ctx).execute(execution, new AbortController().signal)
    await entered.promise
    vi.setSystemTime(new Date(execution.expiresAt!))
    idle.resolve(undefined)
    await expect(running).resolves.toEqual({ status: 'interrupted', interruptionReason: 'expired' })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('registers state and task tools in the exact Agent scope and withdraws them on disposal', async () => {
    const test = await setup()
    const agent = agentFor(test.ctx)
    test.ctx.effect(() => test.ctx.agents.enter(agent, undefined))
    const dispose = registerTaskTools(test.ctx, agent.ctx, agent)
    const execute = (name: string, args: unknown) => test.ctx.agents.withInitiator(agent, () => agent.ctx.tools.execute({ callId: ToolCallId('call'), signal: new AbortController().signal, name, arguments: args, agent }))
    expect((await execute('schedule_state_write', { workflow: 'night', expected_revision: 0, value: { done: true } })).value).toEqual({ workflow: 'night', revision: 1, value: { done: true } })
    const created = (await execute('schedule_task_create', { title: 'Daily', prompt: 'Read state',
      expires_at: '2026-10-13T00:30:00+08:00', daily: { time: '23:40:00', time_zone: 'Asia/Shanghai' } })).value
    expect(created).toMatchObject({ kind: 'daily', scheduledAt: '2026-10-12T15:40:00.000Z', expiresAt: '2026-10-12T16:30:00.000Z' })
    expect((await execute('schedule_task_list', {})).value).toMatchObject([{ title: 'Daily' }])
    const [record] = await test.service.listTasks({ sessionId: agent.session.id })
    expect((await execute('schedule_task_update', { id: record!.id, title: 'Renamed' })).value).toMatchObject({ title: 'Renamed', expiresAt: record!.expiresAt })
    const other = agentFor(test.ctx, 'other-tools')
    const denied = await test.ctx.agents.withInitiator(other, () => agent.ctx.tools.execute({
      callId: ToolCallId('foreign'), signal: new AbortController().signal, name: 'schedule_state_write',
      arguments: { workflow: 'night', expected_revision: 1, value: { done: false } }, agent: other,
    }))
    expect(denied.value).toMatchObject({ code: 'internal_error' })
    expect(await test.service.readState(agent.session.id, 'night')).toMatchObject({ revision: 1, value: { done: true } })
    const before = agent.ctx.tools.schemas(agent).length
    dispose()
    expect(agent.ctx.tools.schemas(agent)).toHaveLength(before - 7)
    expect(renderTaskFraming({ providerId: 'host', id: 'exec' as ScheduleExecutionId, scheduleId: ScheduleId('task'), sessionId: agent.session.id, title: 'Daily', prompt: 'Read state', scheduledAt: '2026-10-12T15:40:00.000Z', createdAt: '2026-10-12T15:40:00.000Z', status: 'running', inputMessageId: MessageId('exec-input') })).toContain('Execute the following user-requested task')
  })
})
