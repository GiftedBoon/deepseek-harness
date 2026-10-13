/** Deterministic external clock, calendar, monitoring and initial authored model decisions. */
import { mock } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Snapshot boundary plugin. */
export const name = 'scheduled-preopen-boundaries'
/** Real services used only to register external fixture providers. */
export const inject = ['llm', 'tools', 'webServer']

const report = '**结论：已完成 ✅**\n目标交易日：2026-10-13\n批次：2026-10-12 23:39:58（延迟 2 秒）\n范围：1107 行 / 571 产品｜待开启：0 行 / 0 产品\n本次检查范围内的预开启判据已通过，当夜守护结束。'
const steps: Array<{ name: string; args: Record<string, unknown> } | { text: string }> = [
  { name: 'schedule_task_create', args: { title: '预开启守护快照', after_seconds: 1, prompt: '加载 preopen-watch，核验 2026-10-13 是否交易日。执行 check_daily_preopen，保存检查状态并报告结果。正常零缺失比对无需报告。' } },
  { text: '已创建预开启检查任务。' },
  { name: 'skill', args: { name: 'preopen-watch' } },
  { name: 'schedule_state_read', args: { workflow: 'preopen-watch' } },
  { name: 'mcp__bssh-ops-remote__get_trading_calendar', args: { at: '2026-10-13T12:00:00+08:00' } },
  { name: 'mcp__bssh-ops-remote__check_daily_preopen', args: { max_detail_rows: 200 } },
  { name: 'schedule_state_write', args: { workflow: 'preopen-watch', expected_revision: 0, value: { version: 1, target: '2026-10-13', done: true, checks: 1, pendingRows: 0 } } },
  { text: report },
]

class AuthoredAdapter extends LlmAdapter {
  private cursor = 0
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const failed = options.messages.find(message => message.role === 'tool' && message.isError)
    if (failed !== undefined) throw new Error(`Real preopen tool failed: ${JSON.stringify(failed.content)}`)
    const step = steps[this.cursor++]
    if (step === undefined) throw new Error('Authored preopen model script exhausted')
    if ('name' in step) {
      if (!options.tools?.some(tool => tool.name === step.name)) throw new Error(`Real tool missing: ${step.name}`)
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId(`scheduled-preopen-${this.cursor}`), name: step.name, argumentsDelta: JSON.stringify(step.args) }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'text-delta', index: 0, text: step.text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

/**
 * Supply deterministic external data without replacing Schedule or Host execution.
 * @param ctx - Shipped Web composition.
 */
export function apply(ctx: Context): void {
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-12T15:39:59Z') })
  ctx.effect(() => () => { mock.timers.reset() })
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/snapshot-clock', handler: async (_request, response) => {
    mock.timers.setTime(Date.parse('2026-10-12T15:40:00Z'))
    response.writeHead(200, { 'content-type': 'text/plain' }); response.end('advanced')
  } }))
  if (process.env.DSH_PREOPEN_AUTHOR === '1') {
    ctx.effect(() => ctx.llm.registerAdapter(['deepseek-official'], new AuthoredAdapter()))
  }
  const output = { schema: { type: 'json' }, render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }] } as const
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mcp__bssh-ops-remote__get_trading_calendar', description: 'Read trading calendar.',
    parameters: { at: { type: 'string', required: true } }, output,
    execute: () => ({ date: '2026-10-13', estimated: false, is_trading_day: true }),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'mcp__bssh-ops-remote__check_daily_preopen', description: 'Read latest production-monitor pre-open batch.',
    parameters: { max_detail_rows: { type: 'integer', required: true } }, output,
    execute: () => ({ ready: true, create_time: '2026-10-12 23:39:58', age_seconds: 2, is_today: true,
      total_rows: 1107, total_products: 571, pending_rows: 0, pending_products: 0,
      pending: [], pending_truncated: false, previous_batch_compared: true, missing_rows: 0, missing: [],
      no_data_file_products: 0, no_data_file_rows: 0, no_data_file: [], no_data_file_truncated: false, not_reporting_rows: 0 }),
  })))
}
