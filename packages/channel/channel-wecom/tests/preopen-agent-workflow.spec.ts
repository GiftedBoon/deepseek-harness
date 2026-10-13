/** Agent-owned pre-open tasks exercise real tools, durable Sessions, and the intelligent-bot outbox. */
import { fileURLToPath } from 'node:url'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { taskComposition } from './task-composition-harness.ts'

const workflow = 'preopen-watch'
const target = '2026-10-13'
const cutoff = `${target}T00:30:00+08:00`
const settings = {
  freshSeconds: 180, stallRepeats: 3, productsPerCheck: 2, retries: 3,
  processWaitSeconds: 180, maxDetailRows: 200, evidenceStart: '23:30:00',
  expectedExcluded: ['GSLS4', 'JPMLS2', 'MSLS2', 'SHORTMSBOXLS1', 'SHORTMSBOXLS2', 'UBSLS2'],
}
const firstReport = '**结论：未完成**\n目标交易日：2026-10-13\n检查时间：2026-10-12 23:40:00（北京时间）\n批次：2026-10-12 23:39:58（延迟 2 秒）\n范围：1107 行 / 571 产品｜待开启：80 行 / 66 产品\n已排除 6 个无数据文件产品，均在预期名单内。\n将每分钟复查，确认完成后播报。'
const doneReport = '**结论：已完成 ✅**\n目标交易日：2026-10-13\n批次：2026-10-12 23:40:58（延迟 2 秒）\n范围：1107 行 / 571 产品｜待开启：0 行 / 0 产品\n**归零检查：以下 13 项均为 0**\n> PnLratio、netMVRatio、Posratio、TradePnLratio、TradeFeeratio\n> MV_shortSell、MV_net\n> traderUnRealizedTradePnL、traderRealizedTradePnL\n> traderTradePnL、traderPositionPnL、traderTotalPnL\n> traderTradingCost\n待开启记录由 80 行降至 0 行，共检查 2 次。\n已排除 6 个无数据文件产品，均在预期名单内。\n本次检查范围内的预开启判据已通过，当夜守护结束。'

type Step = { tool: string; args: () => Record<string, unknown>; receive?: (value: unknown) => void } | { report: string }

/** The scripted provider supplies model decisions; Agent-loop executes every tool and records its result. */
class WorkflowAdapter extends LlmAdapter {
  readonly calls: string[] = []
  private cursor = 0
  private previous: Extract<Step, { tool: string }> | undefined
  constructor(readonly steps: Step[]) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.previous !== undefined) {
      const result = options.messages.findLast(message => message.role === 'tool')
      expect(result).toBeDefined()
      const text = result!.content.filter(block => block.type === 'text').map(block => block.text).join('')
      this.previous.receive?.(this.previous.tool === 'skill' ? text : JSON.parse(text))
      this.previous = undefined
    }
    const step = this.steps[this.cursor++]
    expect(step, 'Unexpected model request after the authored workflow ended').toBeDefined()
    if ('tool' in step!) {
      expect(options.tools?.some(tool => tool.name === step.tool)).toBe(true)
      this.calls.push(step.tool)
      this.previous = step
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`preopen-${this.cursor}`), name: step.tool, argumentsDelta: JSON.stringify(step.args()) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      if (step!.report !== '') yield { type: 'text-delta', index: 0, text: step!.report }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

let host: Awaited<ReturnType<typeof taskComposition>> | undefined
afterEach(async () => { await host?.close(); host = undefined; vi.useRealTimers() })

const skill = (): Step => ({ tool: 'skill', args: () => ({ name: workflow }), receive: (value) => {
  expect(value).toContain('schedule_task_create')
  expect(value).toContain('expires_at')
} })

function stateSteps() {
  let revision = 0
  let value: Record<string, unknown> = { version: 1, settings }
  let entry = ''
  let recheck = ''
  let deadline = ''
  const read = (): Step => ({ tool: 'schedule_state_read', args: () => ({ workflow }), receive: (raw) => {
    const record = z.object({ revision: z.number(), value: z.record(z.string(), z.unknown()).nullable() }).parse(raw)
    revision = record.revision
    if (record.value !== null) value = record.value
  } })
  const write = (update: () => Record<string, unknown>): Step => ({ tool: 'schedule_state_write', args: () => ({ workflow, expected_revision: revision, value: update() }), receive: (raw) => {
    const record = z.object({ revision: z.number(), value: z.record(z.string(), z.unknown()) }).parse(raw)
    revision = record.revision; value = record.value
  } })
  const create = (role: 'entry' | 'recheck' | 'deadline'): Step => ({ tool: 'schedule_task_create', args: () => {
    if (role === 'entry') return { title: '预开启守护：每日入口', daily: { time: '23:40:00', time_zone: 'Asia/Shanghai' }, prompt: '加载 preopen-watch Skill 并执行每日入口。核验下一自然日，保持无变化静默。' }
    if (role === 'deadline') return { title: `预开启守护：${target}截止`, at: { date: target, time: '00:30:00', time_zone: 'Asia/Shanghai' }, prompt: `加载 preopen-watch；目标 ${target}，读取完成标志，未结束则收尾。` }
    return { title: `预开启守护：${target}复查`, every_seconds: 60, expires_at: cutoff, prompt: `加载 preopen-watch；目标 ${target}，读取完成标志和实际时间，执行复查。` }
  }, receive: (raw) => {
    expect(raw, `Task ${role} creation result`).toHaveProperty('id')
    const id = z.object({ id: z.string() }).parse(raw).id
    if (role === 'entry') entry = id
    if (role === 'recheck') recheck = id
    if (role === 'deadline') deadline = id
  } })
  const list = (): Step => ({ tool: 'schedule_task_list', args: () => ({}), receive: (raw) => {
    const records = z.array(z.object({ id: z.string(), scheduledAt: z.string() })).parse(raw)
    if (entry !== '') expect(records.map(record => record.id)).toContain(entry)
  } })
  const night = (done = false) => ({ target, cutoff, done, reason: done ? 'completed' : null, recheckTaskId: recheck, cutoffTaskId: deadline,
    firstReported: true, checks: done ? 2 : 1, pendingRows: done ? 0 : 80, pendingProducts: done ? 0 : 66, queue: [], evidence: [] })
  return { read, write, create, list, night, get value() { return value }, get entry() { return entry },
    get recheck() { return recheck }, get deadline() { return deadline } }
}

async function start(adapter: WorkflowAdapter, calendar: { date: string; estimated: boolean; is_trading_day: boolean },
  checks: Record<string, JsonValue>[], evidence: Record<string, JsonValue> = {}) {
  const warnings: string[] = []
  const businessCalls: Array<{ name: string; args: unknown }> = []
  host = await taskComposition(adapter, {
    skillsDir: fileURLToPath(new URL('../../../../deployments/trader-ops/skills/', import.meta.url)),
    configure: (ctx) => {
      vi.spyOn(ctx.logger, 'warn').mockImplementation((message) => { warnings.push(String(message)) })
      ctx.effect(() => ctx.tools.register(defineTool({ name: 'mcp__bssh-ops-remote__get_trading_calendar', description: 'Read trading calendar.',
        parameters: { at: { type: 'string', required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args) => { businessCalls.push({ name: 'calendar', args }); return calendar },
      })))
      ctx.effect(() => ctx.tools.register(defineTool({ name: 'mcp__bssh-ops-remote__check_daily_preopen', description: 'Read latest production-monitor pre-open batch.',
        parameters: { max_detail_rows: { type: 'integer', required: true } },
        output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args) => { businessCalls.push({ name: 'check', args }); const batch = checks.shift(); expect(batch).toBeDefined(); return batch! },
      })))
      for (const [name, result] of Object.entries(evidence)) {
        ctx.effect(() => ctx.tools.register(defineTool({ name: `mcp__bssh-ops-remote__${name}`, description: 'Read fixture evidence.',
          parameters: { run_id: { type: 'string' }, product: { type: 'string' }, resource_id: { type: 'string' } },
          output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
          execute: async (args) => { businessCalls.push({ name, args }); return result },
        })))
      }
    },
  })
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T15:39:00Z'))
  return { ...host, businessCalls, warnings }
}

function batch(pending: number) {
  return { ready: pending === 0, create_time: pending === 0 ? '2026-10-12 23:40:58' : '2026-10-12 23:39:58', age_seconds: 2,
    is_today: true, total_rows: 1107, total_products: 571, pending_rows: pending, pending_products: pending === 0 ? 0 : 66,
    pending_truncated: pending > 0, pending: [], previous_batch_compared: true, missing_rows: 0, missing: [],
    no_data_file_products: 6, no_data_file_rows: 6, no_data_file_truncated: false,
    no_data_file: settings.expectedExcluded.map(NAME => ({ NAME, Index: '1', Colo: 'fixture' })), not_reporting_rows: 0 }
}

it('creates and reads back Agent tasks, reports the first batch, and completes through the original intelligent bot', { timeout: 30_000 }, async () => {
  const state = stateSteps()
  const calendar = (): Step => ({ tool: 'mcp__bssh-ops-remote__get_trading_calendar', args: () => ({ at: `${target}T12:00:00+08:00` }) })
  const check = (): Step => ({ tool: 'mcp__bssh-ops-remote__check_daily_preopen', args: () => ({ max_detail_rows: settings.maxDetailRows }), receive: (raw) => {
    expect(raw).toMatchObject({ age_seconds: 2, is_today: true, total_rows: 1107, previous_batch_compared: true, missing_rows: 0 })
  } })
  const adapter = new WorkflowAdapter([
    skill(), state.read(), state.list(),
    { tool: 'schedule_task_create', args: () => ({ title: 'Invalid', prompt: 'unused', every_seconds: 60, daily: { time: '23:40:00', time_zone: 'Asia/Shanghai' } }), receive: (raw) =>{  expect(raw).toMatchObject({ code: 'invalid_selector' }) } },
    state.create('entry'), state.write(() => ({ ...state.value, entryTaskId: state.entry })), state.list(), { report: '已创建每日 23:40 预开启任务，已回读编号和下次执行时间。' },
    skill(), state.read(), calendar(),
    state.write(() => ({ ...state.value, night: state.night() })),
    state.create('deadline'), state.write(() => ({ ...state.value, night: state.night() })), state.list(),
    state.create('recheck'), state.write(() => ({ ...state.value, night: state.night() })), state.list(), check(),
    state.write(() => ({ ...state.value, night: state.night() })), { report: firstReport },
    skill(), state.read(), check(), state.write(() => ({ ...state.value, night: state.night(true) })),
    { tool: 'schedule_task_delete', args: () => ({ id: state.recheck }) },
    { tool: 'schedule_task_delete', args: () => ({ id: state.deadline }) }, state.list(), { report: doneReport },
  ])
  const test = await start(adapter, { date: target, estimated: false, is_trading_day: true }, [batch(80), batch(0)])
  test.client.receive('one', '旧守护已关闭。加载 preopen-watch，在当前会话启用每天 23:40 的预开启任务。')
  await vi.waitFor(() =>{  expect(test.client.replies).toHaveLength(1) })
  expect(test.warnings.filter(message => message.startsWith('channel-wecom:'))).toEqual([])
  expect(test.client.replies).toEqual(['已创建每日 23:40 预开启任务，已回读编号和下次执行时间。'])
  const records = await test.ctx.schedule.listTasks({ sessionId: test.sessionId })
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ id: state.entry, scheduledAt: '2026-10-12T15:40:00.000Z', kind: 'daily', time: '23:40:00.000', timeZone: 'Asia/Shanghai' })
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() =>{  expect(test.client.notifications).toHaveLength(1) })
  expect(test.warnings.filter(message => message.startsWith('channel-wecom:'))).toEqual([])
  expect(test.client.notifications[0]?.content).toBe(firstReport)
  expect(await test.ctx.schedule.listTasks({ sessionId: test.sessionId })).toHaveLength(3)
  expect((await test.ctx.schedule.catalog()).find(record => record.id === state.recheck)).toMatchObject({ expiresAt: '2026-10-12T16:30:00.000Z' })
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() =>{  expect(test.client.notifications).toHaveLength(2) })
  expect(test.client.notifications).toEqual([{ target: 'user', content: firstReport }, { target: 'user', content: doneReport }])
  expect(await test.ctx.schedule.listTasks({ sessionId: test.sessionId })).toMatchObject([{ id: state.entry }])
  expect(test.businessCalls).toEqual([{ name: 'calendar', args: { at: `${target}T12:00:00+08:00` } }, { name: 'check', args: { max_detail_rows: 200 } }, { name: 'check', args: { max_detail_rows: 200 } }])
  expect((await test.ctx.schedule.readState(test.sessionId, workflow)).value).toMatchObject({ night: { done: true, checks: 2 } })
  const executions = await test.ctx.schedule.executions({ sessionId: test.sessionId, limit: 10 })
  expect(executions).toHaveLength(2)
  expect(executions.every(record => record.status === 'completed' && record.providerId === 'wecom')).toBe(true)
  await expect(JSON.stringify({ calls: adapter.calls, reports: test.client.notifications, businessCalls: test.businessCalls,
    completion: { done: true, checks: 2, activeTasks: 1, executions: executions.map(record => ({ status: record.status, provider: record.providerId, output: record.output })) } }, null, 2) + '\n').toMatchFileSnapshot('./expected/preopen-agent-workflow.json')
})

it('skips a verified non-trading natural date without querying production or sending an empty reply', { timeout: 30_000 }, async () => {
  const state = stateSteps()
  const adapter = new WorkflowAdapter([
    skill(), state.read(), state.create('entry'), state.write(() => ({ ...state.value, entryTaskId: state.entry })), state.list(), { report: '每日任务已创建。' },
    skill(), state.read(), { tool: 'mcp__bssh-ops-remote__get_trading_calendar', args: () => ({ at: `${target}T12:00:00+08:00` }), receive: (raw) =>{  expect(raw).toMatchObject({ date: target, estimated: false, is_trading_day: false }) } },
    state.write(() => ({ ...state.value, night: { target, done: true, reason: 'non_trading_day' } })), { report: '' },
  ])
  const test = await start(adapter, { date: target, estimated: false, is_trading_day: false }, [])
  test.client.receive('one', '旧守护已关闭。启用 preopen-watch。')
  await vi.waitFor(() =>{  expect(test.client.replies).toEqual(['每日任务已创建。']) })
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(async () =>{  expect((await test.ctx.schedule.executions({ sessionId: test.sessionId, limit: 10 }))[0]?.status).toBe('completed') })
  expect(test.businessCalls.map(call => call.name)).toEqual(['calendar'])
  expect(test.client.notifications).toEqual([])
  expect(test.client.replies).toEqual(['每日任务已创建。'])
  expect(await test.ctx.schedule.listTasks({ sessionId: test.sessionId })).toHaveLength(1)
  expect((await test.ctx.schedule.readState(test.sessionId, workflow)).value).toMatchObject({ night: { done: true, reason: 'non_trading_day' } })
})

it('retains unknown workflow state and reports recovery without creating a duplicate task', { timeout: 30_000 }, async () => {
  const state = stateSteps()
  const adapter = new WorkflowAdapter([skill(), state.read(), { report: '预开启状态版本 99 未受支持，已保留原记录；请先核验已有任务和恢复状态。' }])
  const test = await start(adapter, { date: target, estimated: false, is_trading_day: true }, [])
  await test.ctx.schedule.writeState(test.sessionId, workflow, 0, { version: 99, entryTaskId: 'retained-task', night: { target, done: false, run_id: 'retained-run' } })
  test.client.receive('one', '旧守护已关闭。启用 preopen-watch。')
  await vi.waitFor(() =>{  expect(test.client.replies).toEqual(['预开启状态版本 99 未受支持，已保留原记录；请先核验已有任务和恢复状态。']) })
  expect(await test.ctx.schedule.listTasks({ sessionId: test.sessionId })).toEqual([])
  expect(await test.ctx.schedule.readState(test.sessionId, workflow)).toMatchObject({ revision: 1, value: { version: 99, night: { run_id: 'retained-run' } } })
  expect(test.businessCalls).toEqual([])
})

it('preserves a created cutoff after a failed recheck creation and closes a night with no verified data', { timeout: 30_000 }, async () => {
  const state = stateSteps()
  const setupReport = '交易日未核验：交易日历为估算。截止任务已保存；复查任务创建失败，未完整启用。'
  const finalReport = '**结论：未确认完成**\n目标交易日：2026-10-13\n整夜未核验交易日，未取得当夜有效监控批次。\n截止时间：2026-10-13 00:30:00（北京时间）\n当夜守护已收尾。'
  const adapter = new WorkflowAdapter([
    skill(), state.read(), state.create('entry'), state.write(() => ({ ...state.value, entryTaskId: state.entry })), state.list(), { report: '每日任务已创建。' },
    skill(), state.read(), { tool: 'mcp__bssh-ops-remote__get_trading_calendar', args: () => ({ at: `${target}T12:00:00+08:00` }), receive: (raw) =>{  expect(raw).toMatchObject({ date: target, estimated: true }) } },
    state.write(() => ({ ...state.value, night: { ...state.night(), calendarVerified: false, firstReported: false } })),
    state.create('deadline'), state.write(() => ({ ...state.value, night: { ...state.night(), calendarVerified: false, firstReported: false } })), state.list(),
    { tool: 'schedule_task_create', args: () => ({ title: `预开启守护：${target}复查`, prompt: '读取完成标志后复查。', every_seconds: 60, expires_at: '2026-10-12T23:40:00+08:00' }), receive: (raw) =>{  expect(raw).toMatchObject({ code: 'invalid_rule' }) } },
    state.list(), { report: setupReport },
    skill(), state.read(), state.write(() => ({ ...state.value, night: { ...state.night(), done: true, reason: 'calendar_unverified', lastValidBatch: null } })),
    { tool: 'schedule_task_delete', args: () => ({ id: state.deadline }) }, state.list(), { report: finalReport },
  ])
  const test = await start(adapter, { date: target, estimated: true, is_trading_day: true }, [])
  test.client.receive('one', '旧守护已关闭。启用 preopen-watch。')
  await vi.waitFor(() =>{  expect(test.client.replies).toEqual(['每日任务已创建。']) })
  await vi.advanceTimersByTimeAsync(60_000)
  await vi.waitFor(() =>{  expect(test.client.notifications).toEqual([{ target: 'user', content: setupReport }]) })
  expect(await test.ctx.schedule.listTasks({ sessionId: test.sessionId })).toMatchObject([{ id: state.entry }, { id: state.deadline }])
  expect((await test.ctx.schedule.readState(test.sessionId, workflow)).value).toMatchObject({ night: { cutoffTaskId: state.deadline, recheckTaskId: '', done: false } })
  await vi.advanceTimersByTimeAsync(Date.parse(cutoff) - Date.now())
  await vi.waitFor(() =>{  expect(test.client.notifications).toHaveLength(2) })
  expect(test.client.notifications[1]).toEqual({ target: 'user', content: finalReport })
  expect(test.businessCalls.map(call => call.name)).toEqual(['calendar'])
  expect((await test.ctx.schedule.readState(test.sessionId, workflow)).value).toMatchObject({ night: { done: true, reason: 'calendar_unverified', lastValidBatch: null } })
  expect(await test.ctx.schedule.listTasks({ sessionId: test.sessionId })).toMatchObject([{ id: state.entry }])
  await expect(JSON.stringify({ reports: test.client.notifications, businessCalls: test.businessCalls, activeTasks: 1, cutoffIdRetained: state.deadline !== '' }, null, 2) + '\n').toMatchFileSnapshot('./expected/preopen-agent-no-valid-data.json')
})

it('resumes a persisted process run and retains separate historical-log and failed-colo evidence', { timeout: 30_000 }, async () => {
  const state = stateSteps()
  const report = '**预开启自动排查**\n目标交易日：2026-10-13\n仍待开启：2 行 / 1 产品\n> HJ1 · csc-sh-12：进程输出未确认该产品；failed 记录早于当夜窗口，原因未确认。\n> HJ1 · csc-sz-12：日志读取失败，保留队列，下一轮重试。\n已保存各台证据，继续复查。'
  let recheckId = ''
  const adapter = new WorkflowAdapter([
    skill(), state.read(),
    { tool: 'schedule_task_create', args: () => ({ title: `预开启守护：${target}复查`, prompt: '加载 preopen-watch，恢复已有进程检查编号并推进每台证据。', after_seconds: 1, expires_at: cutoff }), receive: (raw) => { recheckId = z.object({ id: z.string() }).parse(raw).id } },
    state.write(() => ({ ...state.value, recheckTaskId: recheckId })), { report: '已恢复当前夜晚复查。' },
    skill(), state.read(),
    { tool: 'mcp__bssh-ops-remote__check_daily_preopen', args: () => ({ max_detail_rows: 200 }), receive: (raw) =>{  expect(raw).toMatchObject({ pending_rows: 2, pending_products: 1, pending_truncated: false }) } },
    { tool: 'mcp__bssh-ops-remote__get_run_status', args: () => ({ run_id: 'readonly-retained-7' }), receive: (raw) =>{  expect(raw).toMatchObject({ run_id: 'readonly-retained-7', status: 'finished' }) } },
    { tool: 'mcp__bssh-ops-remote__get_strategy_start_errors', args: () => ({ product: 'HJ1' }), receive: (raw) =>{  expect(raw).toMatchObject({ colos: [{ colo: 'csc-sh-12', total_matched: 1 }, { colo: 'csc-sz-12', error: 'connection timeout' }] }) } },
    { tool: 'mcp__bssh-ops-remote__list_colo_file_resources', args: () => ({ product: 'HJ1' }) },
    { tool: 'mcp__bssh-ops-remote__stat_colo_file', args: () => ({ product: 'HJ1', resource_id: 'strategy_log' }) },
    state.write(() => ({ ...state.value, night: { target, cutoff, done: false,
      queue: [{ product: 'HJ1', colo: 'csc-sz-12', run_id: 'readonly-retained-7', stage: 'logs', failures: 1 }],
      evidence: [
        { product: 'HJ1', colo: 'csc-sh-12', phase: 'finished', process: 'unconfirmed', logTime: 'historical', summary: '旧 failed 不能确认当夜故障。', totalMatched: 1 },
        { product: 'HJ1', colo: 'csc-sz-12', phase: 'retry', failures: 1, summary: 'connection timeout' },
      ] } })), { report },
  ])
  const test = await start(adapter, { date: target, estimated: false, is_trading_day: true }, [{
    ...batch(2), pending_products: 1, pending_truncated: false,
    pending: [{ NAME: 'HJ1', Index: '1', Colo: 'csc-sh-12', Exchange: 'SH', nonzero_fields: ['MV_net'] }, { NAME: 'HJ1', Index: '1', Colo: 'csc-sz-12', Exchange: 'SZ', nonzero_fields: ['MV_net'] }],
  }], {
    check_process_status: { run_id: 'must-not-redispatch' },
    get_run_status: { run_id: 'readonly-retained-7', status: 'finished', colos: [{ colo: 'csc-sh-12', output: 'python other-product.py' }, { colo: 'csc-sz-12', output: 'python HJ1.py' }] },
    get_strategy_start_errors: { colos: [{ colo: 'csc-sh-12', total_matched: 1, lines: [{ line: 218, text: '2026-10-11T23:35:00+08:00 failed historical config' }] }, { colo: 'csc-sz-12', error: 'connection timeout' }] },
    list_colo_file_resources: { resources: [{ resource_id: 'strategy_log' }] },
    stat_colo_file: { colos: [{ colo: 'csc-sh-12', size: 1024, modified_at: '2026-10-11T23:35:00+08:00', lines: 218 }] },
  })
  await test.ctx.schedule.writeState(test.sessionId, workflow, 0, { version: 1, settings,
    night: { target, cutoff, done: false, calendarVerified: true, queue: [{ product: 'HJ1', colos: ['csc-sh-12', 'csc-sz-12'], run_id: 'readonly-retained-7', dispatchedAt: '2026-10-12T23:38:00+08:00', stage: 'process', failures: 0 }] },
  })
  test.client.receive('one', '旧守护已关闭。恢复 preopen-watch 的当夜排查。')
  await vi.waitFor(() =>{  expect(test.client.replies).toEqual(['已恢复当前夜晚复查。']) })
  await vi.advanceTimersByTimeAsync(1000)
  await vi.waitFor(() =>{  expect(test.client.notifications).toEqual([{ target: 'user', content: report }]) })
  expect(test.businessCalls.map(call => call.name)).toEqual(['check', 'get_run_status', 'get_strategy_start_errors', 'list_colo_file_resources', 'stat_colo_file'])
  expect(test.businessCalls[1]).toEqual({ name: 'get_run_status', args: { run_id: 'readonly-retained-7' } })
  expect((await test.ctx.schedule.readState(test.sessionId, workflow)).value).toMatchObject({ night: { done: false,
    evidence: [{ colo: 'csc-sh-12', phase: 'finished', logTime: 'historical' }, { colo: 'csc-sz-12', phase: 'retry', failures: 1 }],
    queue: [{ colo: 'csc-sz-12', run_id: 'readonly-retained-7', failures: 1 }],
  } })
  await expect(JSON.stringify({ report: test.client.notifications, calls: test.businessCalls }, null, 2) + '\n').toMatchFileSnapshot('./expected/preopen-agent-evidence.json')
})
