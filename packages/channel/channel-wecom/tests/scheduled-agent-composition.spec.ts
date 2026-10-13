/** Scheduled Agent output and human ingress on a real Loader-owned Host composition. */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import { ScheduleId, type ScheduleExecution, type ScheduleExecutionId } from '@deepseek-ai/dsh-schedule'
import { taskComposition } from './task-composition-harness.ts'

class Adapter extends LlmAdapter {
  requests = 0
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()
  hold = false
  silent = false
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    if (this.requests === 2 && this.hold) {
      this.entered.resolve(undefined)
      const abort = (): void => { this.release.resolve(undefined) }
      options.signal?.addEventListener('abort', abort, { once: true })
      try {
        await this.release.promise
        options.signal?.throwIfAborted()
      } finally { options.signal?.removeEventListener('abort', abort) }
    }
    if (!this.silent) yield { type: 'text-delta', index: 0, text: this.requests === 2 ? '定时检测完成' : '用户回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

let host: Awaited<ReturnType<typeof taskComposition>> | undefined
afterEach(async () => { await host?.close(); host = undefined; vi.useRealTimers() })

it('cold resumes an executable task and queues human ingress behind its correlated turn', { timeout: 30_000 }, async () => {
  const adapter = new Adapter()
  adapter.hold = true
  host = await taskComposition(adapter)
  const { ctx, client, sessionId } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toEqual(['用户回复']); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  const task = await ctx.schedule.createTask(sessionId, { title: '检测', prompt: '执行只读检测', after_seconds: 1 })
  await adapter.entered.promise
  const running = (await ctx.schedule.executions({ sessionId, limit: 10 }))[0]!
  expect(running.providerId).toBe('wecom')
  expect(ctx.permissionPresets.current(ctx.agents.get(sessionId)!.session)).toBe('unattended')
  client.receive('two', 'second user')
  expect(adapter.requests).toBe(2)
  adapter.release.resolve(undefined)
  await vi.waitFor(() => {
    expect(client.notifications).toEqual([{ target: 'user', content: '定时检测完成' }])
    expect(client.replies).toEqual(['用户回复', '用户回复'])
    expect(ctx.agents.get(sessionId)).toBeUndefined()
  })
  const execution = (await ctx.schedule.executions({ sessionId, limit: 10 }))[0]!
  expect(execution.status).toBe('completed')
  expect(execution.inputMessageId).toBeDefined()
  expect(execution.messageIds).toHaveLength(1)
  await using stored = await ctx.sessionPersistence.open(sessionId, 'read')
  const session = await stored.read()
  expect(session.events.filter(event => event.type === 'user/message').map(event => event.data.id)).toContain(execution.inputMessageId)
  await expect(JSON.stringify({
    replies: client.replies, notifications: client.notifications,
    provider: execution.providerId, status: execution.status, output: execution.output,
    inputRecorded: session.events.some(event => event.type === 'user/message' && event.data.id === execution.inputMessageId),
    outputRecorded: session.events.some(event => event.type === 'assistant/message' && execution.messageIds?.includes(event.data.message.id)),
    taskEnded: (await ctx.schedule.listTasks({ sessionId })).every(record => record.id !== task.id),
  }, null, 2) + '\n').toMatchFileSnapshot('./expected/scheduled-agent.json')
})

it('keeps successful no-output tasks silent and removes its executor on disposal', { timeout: 30_000 }, async () => {
  const adapter = new Adapter()
  host = await taskComposition(adapter)
  const { ctx, client, sessionId } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  adapter.silent = true
  await ctx.schedule.createTask(sessionId, { title: '静默', prompt: '无变化时保持静默', after_seconds: 1 })
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('completed') }, { timeout: 10_000 })
  expect(client.notifications).toEqual([])
  expect(client.replies).toEqual(['用户回复'])
  await host.runtime.close()
  expect(client.listener).toBeUndefined()
})


it('executes a tool through the ordinary policy pipeline in the restored permission preset', { timeout: 30_000 }, async () => {
  let calls = 0
  class ToolAdapter extends LlmAdapter {
    requests = 0
    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++this.requests === 2) {
        expect(options.tools?.some(tool => tool.name === 'probe')).toBe(true)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('read-only'), name: 'probe', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'text-delta', index: 0, text: this.requests === 1 ? '用户回复' : '检测工具完成' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  host = await taskComposition(new ToolAdapter(), { configure(ctx) {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'probe', description: 'Read-only external probe.', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async (_args, execution) => {
        expect(ctx.permissionPresets.current(execution.agent!.session)).toBe('unattended')
        calls++
        return 'fresh'
      },
    })))
  } })
  const { ctx, client, sessionId } = host
  const policy: string[] = []
  ctx.on('tools/pre-execute', (execution, next) => { policy.push(execution.name); return next() })
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  await ctx.schedule.createTask(sessionId, { title: '调用工具', prompt: '调用 probe 检测', after_seconds: 1 })
  await vi.waitFor(() => { expect(client.notifications).toEqual([{ target: 'user', content: '检测工具完成' }]) }, { timeout: 10_000 })
  expect(calls).toBe(1)
  expect(policy).toContain('probe')
  await using stored = await ctx.sessionPersistence.open(sessionId, 'read')
  expect((await stored.read()).events.some(event => event.type === 'tool/result')).toBe(true)
})

it('replays an unsent committed report after restart without invoking the Agent again', { timeout: 30_000 }, async () => {
  const adapter = new Adapter()
  host = await taskComposition(adapter)
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  client.failSend = true
  await ctx.schedule.createTask(sessionId, { title: '报告', prompt: '输出报告', after_seconds: 1 })
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('completed') }, { timeout: 10_000 })
  const execution = (await ctx.schedule.executions({ sessionId, limit: 10 }))[0]!
  const reports = ctx.storageDomain.get('channel_wecom_task_reports')!
  await vi.waitFor(() => { expect(reports.table('reports').get(`task:${execution.id}`)).toMatchObject({ state: 'queued' }) })
  await host.close(false)
  const resumed = new Adapter()
  host = await taskComposition(resumed, { root })
  await vi.waitFor(() => { expect(host!.client.notifications).toEqual([{ target: 'user', content: '定时检测完成' }]) })
  expect(resumed.requests).toBe(0)
  const receipts = host.ctx.storageDomain.get('channel_wecom_task_reports')!
  expect(receipts.table('reports').get(`task:${execution.id}`)).toMatchObject({ state: 'delivered' })
  await host.close(false)
  host = await taskComposition(new Adapter(), { root })
  expect(host.client.notifications).toEqual([])
})

it('recovers an orphan report behind more than one page of delivered execution history', { timeout: 30_000 }, async () => {
  host = await taskComposition(new Adapter())
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  client.failSend = true
  await ctx.schedule.createTask(sessionId, { title: '旧报告', prompt: '输出报告', after_seconds: 1 })
  const reports = ctx.storageDomain.get('channel_wecom_task_reports')!
  await vi.waitFor(() => { expect([...reports.table('reports').entries()]).toHaveLength(1) }, { timeout: 10_000 })
  const execution = (await ctx.schedule.executions({ sessionId, limit: 10 }))[0]!
  await reports.table('reports').delete(`task:${execution.id}`)
  expect(ctx.storageDomain.get('channel_wecom')!.table('outbox').get(`task:${execution.id}`)).toBeDefined()
  const executions = ctx.storageDomain.get('schedule_execution')!.table('executions')
  for (let index = 1; index <= 105; index++) {
    const id = `newer-${index}` as ScheduleExecutionId
    await executions.put(id, { ...execution, id, inputMessageId: MessageId(`input-${index}`), createdAt: new Date(Date.parse(execution.createdAt) + index).toISOString() })
    await reports.table('reports').put(`task:${id}`, { state: 'delivered', sessionId, createdAt: Date.now() })
  }
  expect(await ctx.schedule.executions({ sessionId, limit: 100 })).not.toContainEqual(execution)
  await host.close(false)
  const recovered = new Adapter()
  host = await taskComposition(recovered, { root })
  expect(host.client.notifications).toEqual([{ target: 'user', content: '定时检测完成' }])
  expect(recovered.requests).toBe(0)
  expect(host.ctx.storageDomain.get('channel_wecom_task_reports')!.table('reports').get(`task:${execution.id}`)).toMatchObject({ state: 'delivered' })
  await host.close(false)
  host = await taskComposition(new Adapter(), { root })
  expect(host.client.notifications).toEqual([])
})

it('finishes recovery paging before a queued execution can prune its cursor', { timeout: 30_000 }, async () => {
  host = await taskComposition(new Adapter(), { taskExecutionRecords: 1 })
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  const task = await ctx.schedule.createTask(sessionId, { title: '恢复检测', prompt: '输出报告', after_seconds: 86400 })
  const now = Date.now()
  const old: ScheduleExecution = {
    id: 'cursor-old' as ScheduleExecutionId, providerId: 'wecom', scheduleId: task.id, sessionId,
    title: task.title, prompt: task.prompt, scheduledAt: new Date(now - 1000).toISOString(),
    createdAt: new Date(now - 1000).toISOString(), status: 'completed',
    inputMessageId: MessageId('cursor-old-input'), output: '已送达',
  }
  const executions = ctx.storageDomain.get('schedule_execution')!.table('executions')
  const reports = ctx.storageDomain.get('channel_wecom_task_reports')!.table('reports')
  await executions.put(old.id, old)
  await reports.put(`task:${old.id}`, { state: 'delivered', sessionId, createdAt: now })
  for (let index = 0; index < 100; index++) {
    const id = `cursor-filler-${index}` as ScheduleExecutionId
    await executions.put(id, { ...old, id, scheduleId: ScheduleId(`filler-${index}`),
      inputMessageId: MessageId(`cursor-filler-input-${index}`),
      createdAt: new Date(now + (index < 98 ? index : -2000 - index)).toISOString() })
    await reports.put(`task:${id}`, { state: 'delivered', sessionId, createdAt: now })
  }
  const queued = { ...old, id: 'cursor-queued' as ScheduleExecutionId, status: 'queued' as const,
    inputMessageId: MessageId('cursor-queued-input'), createdAt: new Date(now + 1000).toISOString() }
  await executions.put(queued.id, queued)
  await host.close(false)
  host = undefined
  let pages = 0
  host = await taskComposition(new Adapter(), { root, taskExecutionRecords: 1, configure(owner) {
    const register = owner.schedule.registerTaskExecutor.bind(owner.schedule)
    let registered = false
    vi.spyOn(owner.schedule, 'registerTaskExecutor').mockImplementation((provider) => {
      registered = true
      return register(provider)
    })
    const read = owner.schedule.executions.bind(owner.schedule)
    vi.spyOn(owner.schedule, 'executions').mockImplementation(async (request) => {
      const page = await read(request)
      if (++pages === 1) {
        expect(page.at(-1)?.id).toBe(old.id)
        if (registered) {
          // Let the real queued execution settle while this page's cursor is held.
          await vi.waitFor(() => { expect(owner.storageDomain.get('schedule_execution')!.table('executions').get(old.id)).toBeUndefined() })
        }
      }
      return page
    })
  } })
  expect(pages).toBe(2)
  await vi.waitFor(() => { expect(host!.ctx.storageDomain.get('schedule_execution')!.table('executions').get(queued.id)).toMatchObject({ status: 'completed' }) })
  expect(host.ctx.storageDomain.get('schedule_execution')!.table('executions').get(old.id)).toBeUndefined()
  await vi.waitFor(() => { expect(host!.client.notifications).toEqual([{ target: 'user', content: '用户回复' }]) })
})

it('refuses wildcard-only restored routes and suppresses unsent output when access is revoked', { timeout: 30_000 }, async () => {
  const adapter = new Adapter()
  host = await taskComposition(adapter)
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  client.failSend = true
  await ctx.schedule.createTask(sessionId, { title: '旧报告', prompt: '报告', after_seconds: 1 })
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('completed') }, { timeout: 10_000 })
  const oldExecution = (await ctx.schedule.executions({ sessionId, limit: 10 }))[0]!
  await ctx.storageDomain.get('channel_wecom_task_reports')!.table('reports').delete(`task:${oldExecution.id}`)
  await host.close(false)
  const denied = new Adapter()
  host = await taskComposition(denied, { root, allowedUsers: ['*'] })
  expect(host.client.notifications).toEqual([])
  await host.ctx.schedule.createTask(sessionId, { title: '禁止执行', prompt: '不应执行', after_seconds: 1 })
  await vi.waitFor(async () => { expect((await host!.ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('failed') }, { timeout: 10_000 })
  expect(denied.requests).toBe(0)
  expect(host.client.notifications).toEqual([])
})

it('closes an in-flight scheduled model request to quiescence and restores its executor on reload', { timeout: 30_000 }, async () => {
  class AbortAdapter extends LlmAdapter {
    requests = 0
    readonly entered = Promise.withResolvers<undefined>()
    readonly aborted = Promise.withResolvers<undefined>()
    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (++this.requests === 2) {
        this.entered.resolve(undefined)
        await new Promise<void>((resolve) => {
          if (options.signal!.aborted) resolve()
          else options.signal!.addEventListener('abort', () => { this.aborted.resolve(undefined); resolve() }, { once: true })
        })
        this.aborted.resolve(undefined)
        options.signal!.throwIfAborted()
      }
      yield { type: 'text-delta', index: 0, text: '用户回复' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new AbortAdapter()
  host = await taskComposition(adapter)
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  await ctx.schedule.createTask(sessionId, { title: '中断', prompt: '检测', after_seconds: 1 })
  await adapter.entered.promise
  await host.runtime.close()
  await adapter.aborted.promise
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('interrupted') })
  expect(ctx.agents.get(sessionId)).toBeUndefined()
  expect(client.listener).toBeUndefined()
  await host.close(false)
  const reloaded = new Adapter()
  host = await taskComposition(reloaded, { root })
  expect(reloaded.requests).toBe(0)
  await host.ctx.schedule.createTask(sessionId, { title: '重载', prompt: '检测', after_seconds: 1 })
  await vi.waitFor(async () => { expect((await host!.ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('completed') }, { timeout: 10_000 })
  expect(reloaded.requests).toBe(1)
})

it('reports a crash-orphaned execution as uncertain without replaying its Agent input', { timeout: 30_000 }, async () => {
  host = await taskComposition(new Adapter())
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  await ctx.schedule.createTask(sessionId, { title: '崩溃', prompt: '检测', after_seconds: 1 })
  await vi.waitFor(() => { expect(client.notifications).toHaveLength(1) }, { timeout: 10_000 })
  const execution = (await ctx.schedule.executions({ sessionId, limit: 10 }))[0]!
  const reports = ctx.storageDomain.get('channel_wecom_task_reports')!
  await reports.table('reports').delete(`task:${execution.id}`)
  const executionStore = ctx.storageDomain.get('schedule_execution')!
  await executionStore.table('executions').put(execution.id, { ...execution, status: 'running', output: undefined, messageIds: undefined })
  await host.close(false)
  const recovered = new Adapter()
  host = await taskComposition(recovered, { root })
  expect(recovered.requests).toBe(0)
  expect(host.client.notifications).toEqual([{ target: 'user', content: '未知' }])
  expect((await host.ctx.schedule.executions({ sessionId, limit: 10 }))[0]).toMatchObject({ status: 'interrupted', interruptionReason: 'crash' })
})


it('expires a task waiting behind human ingress before submitting its Agent input', { timeout: 30_000 }, async () => {
  const adapter = new Adapter()
  adapter.hold = true
  host = await taskComposition(adapter)
  const { ctx, client, sessionId } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  client.receive('two', 'hold human input')
  await adapter.entered.promise
  await ctx.schedule.createTask(sessionId, { title: '过期任务', prompt: '不应执行', after_seconds: 1, expires_at: new Date(Date.now() + 60_000).toISOString() })
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 }))[0]?.status).toBe('running') }, { timeout: 10_000 })
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 120_000)
  adapter.release.resolve(undefined)
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 }))[0]).toMatchObject({ status: 'interrupted', interruptionReason: 'expired' }) })
  expect(adapter.requests).toBe(2)
  expect(client.notifications).toEqual([])
  vi.useRealTimers()
})

it('keeps deletion of an unstarted queued tick silent', { timeout: 30_000 }, async () => {
  const adapter = new Adapter()
  adapter.hold = true
  host = await taskComposition(adapter)
  const { ctx, client, sessionId } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  await ctx.schedule.createTask(sessionId, { title: '运行中', prompt: '检测', after_seconds: 1 })
  await adapter.entered.promise
  const queued = await ctx.schedule.createTask(sessionId, { title: '将取消', prompt: '不应执行', after_seconds: 1 })
  await vi.waitFor(async () => { expect((await ctx.schedule.executions({ sessionId, limit: 10 })).some(value => value.scheduleId === queued.id && value.status === 'queued')).toBe(true) }, { timeout: 10_000 })
  await ctx.schedule.delete({ sessionId, id: queued.id })
  expect((await ctx.schedule.executions({ sessionId, limit: 10 })).find(value => value.scheduleId === queued.id)).toMatchObject({ status: 'interrupted', interruptionReason: 'cancelled' })
  adapter.release.resolve(undefined)
  await vi.waitFor(() => { expect(client.notifications).toEqual([{ target: 'user', content: '定时检测完成' }]) })
  expect(adapter.requests).toBe(2)
})


it('expires old unsent reports and does not reconstruct them from retained execution output', { timeout: 30_000 }, async () => {
  host = await taskComposition(new Adapter())
  const { ctx, client, sessionId, root } = host
  client.receive('one', 'hello')
  await vi.waitFor(() => { expect(client.replies).toHaveLength(1); expect(ctx.agents.get(sessionId)).toBeUndefined() })
  client.failSend = true
  await ctx.schedule.createTask(sessionId, { title: '过期报告', prompt: '报告', after_seconds: 1 })
  const reports = ctx.storageDomain.get('channel_wecom_task_reports')!
  await vi.waitFor(() => { expect([...reports.table('reports').entries()]).toHaveLength(1) }, { timeout: 10_000 })
  await host.close(false)
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000)
  const resumed = new Adapter()
  host = await taskComposition(resumed, { root })
  expect(host.client.notifications).toEqual([])
  expect([...host.ctx.storageDomain.get('channel_wecom')!.table('outbox').entries()]).toEqual([])
  await vi.waitFor(() => { expect([...host!.ctx.storageDomain.get('channel_wecom_task_reports')!.table('reports').entries()]).toEqual([]) })
  expect(resumed.requests).toBe(0)
  vi.useRealTimers()
})
