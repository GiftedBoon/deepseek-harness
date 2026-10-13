import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Deployment plugins are plain ESM consumed by the dsh profile loader.
import * as watcher from '../deployments/trader-ops/scripts/preopen-watch.mjs'
// @ts-expect-error Deployment plugins are plain ESM consumed by the dsh profile loader.
import * as plugin from '../deployments/trader-ops/scripts/preopen-watch-plugin.mjs'

interface Evidence { product: string; summary: string; colos: Record<string, unknown>[] }
interface Session {
  done: boolean
  queue: { runId: string | null; attempts: number }[]
  evidence: Evidence[]
  outbox: { content: string; attempts: number }[]
}
interface State { version: number; sessions: Record<string, Session> }
interface Config { stateDir: string; start: string; end: string; [key: string]: unknown }
interface Adapters {
  now: () => number
  call: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
  save: (state: State) => Promise<void>
  send: (content: string) => Promise<void>
  cancelled?: () => boolean
}
const { createWatch, resolveConfig, windowAt, readState, writeState, decodeState, classifyLog } = watcher as {
  resolveConfig: (input: Record<string, unknown>) => Config
  windowAt: (now: number, config: Config) => { session: string; start: number; evidenceStart: number; deadline: number }
  createWatch: (config: Config, adapters: Adapters, state?: State) => { tick: () => Promise<void>; state: State }
  readState: (root: string) => Promise<State>
  writeState: (root: string, state: State) => Promise<void>
  decodeState: (state: object) => State
  classifyLog: (lines: string[], start: number, now: number) => string
}
const { remoteValue, apply } = plugin as {
  remoteValue: (result: object) => Record<string, unknown>
  apply: (ctx: object, config: object) => Promise<void>
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const at = (time: string) => Date.parse(`2026-10-12T${time}:00+08:00`)
const pending = (product = 'HJ1', colo = 'csc-sh-12') => ({ NAME: product, Colo: colo, Index: 'MIX3', Exchange: 'SH', TraderAccount: 'must-not-persist' })
function batch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ready: false, total_rows: 2, total_products: 1, pending_rows: 2, pending_products: 1,
    pending: [pending(), pending('HJ1', 'csc-sz-12')], pending_truncated: false,
    create_time: '2026-10-12 23:39:58', age_seconds: 2, is_today: true,
    missing_rows: 0, previous_batch_compared: true, no_data_file: [], no_data_file_truncated: false,
    no_data_file_rows: 0, no_data_file_products: 0, not_reporting_rows: 0, ...overrides,
  }
}
function fixture() {
  let now = at('23:40')
  let current = batch()
  const messages: string[] = []
  const saved: string[] = []
  const call = vi.fn(async (name: string, _args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (name) {
      case 'get_trading_calendar': return { date: '2026-10-13', is_trading_day: true, estimated: false }
      case 'check_daily_preopen': return current
      case 'check_process_status': return { run_id: 'run-1' }
      case 'get_run_status': return { status: 'running' }
      case 'get_strategy_start_errors': return { colos: [] }
      case 'list_colo_file_resources': return { resources: [{ resource_id: 'strategy_log' }] }
      case 'stat_colo_file': return { colos: [] }
      default: throw new Error('unexpected tool')
    }
  })
  const config = resolveConfig({ stateDir: join(tmpdir(), 'parser-only-preopen-path') })
  const adapters: Adapters = {
    now: () => now, call, save: async (state) => { saved.push(JSON.stringify(state)) },
    send: async (content) => { messages.push(content) },
  }
  const watch = createWatch(config, adapters)
  return { watch, config, adapters, call, messages, saved,
    time: (value: string) => { now = value.includes('T') ? Date.parse(value) : at(value) },
    batch: (value: Record<string, unknown>) => { current = value },
  }
}

describe('pre-open scheduled reports', () => {
  it('reports the first check, completes, and omits successful zero-missing comparisons', async () => {
    const f = fixture()
    await f.watch.tick()
    f.time('23:41')
    f.batch(batch({ ready: true, pending_rows: 0, pending_products: 0, pending: [] }))
    await f.watch.tick()
    expect(f.messages).toMatchSnapshot()
    expect(f.messages.join('\n')).not.toContain('上一批')
    expect(f.saved.join('\n')).not.toContain('must-not-persist')
    expect(f.watch.state.sessions['2026-10-13']!.done).toBe(true)
    f.time('23:42')
    await f.watch.tick()
    expect(f.messages).toHaveLength(2)
  })

  it.each([
    { is_trading_day: false, estimated: false },
    { is_trading_day: true, estimated: true },
    { is_trading_day: 'true', estimated: false },
  ])('never checks production without a verified trading date: %j', async (result) => {
    const f = fixture()
    f.call.mockImplementation(async () => ({ date: '2026-10-13', ...result }))
    await f.watch.tick()
    expect(f.call.mock.calls.map(([name]) => name)).not.toContain('check_daily_preopen')
  })

  it('keeps missing records, unknown comparisons, and reporting lag visible', async () => {
    const f = fixture()
    f.batch(batch({ ready: true, pending_rows: 0, pending_products: 0, pending: [], missing_rows: 1,
      previous_batch_compared: false, not_reporting_rows: 1 }))
    await f.watch.tick()
    expect(f.messages[0]).toContain('缺失记录：1')
    expect(f.messages[0]).toContain('上一批比对未完成')
    expect(f.messages[0]).toContain('零值可能陈旧')
    expect(f.watch.state.sessions['2026-10-13']!.done).toBe(false)
  })

  it('does not accept an unexpected or truncated exclusion list as completion', async () => {
    const f = fixture()
    f.batch(batch({ ready: true, pending_rows: 0, pending_products: 0, pending: [],
      no_data_file: [pending('UNEXPECTED')], no_data_file_products: 1, no_data_file_rows: 1 }))
    await f.watch.tick()
    expect(f.watch.state.sessions['2026-10-13']!.done).toBe(false)
    expect(f.messages[0]).toContain('非预期排除产品')
    f.time('23:41')
    f.batch(batch({ ready: true, pending_rows: 0, pending_products: 0, pending: [], no_data_file_truncated: true }))
    await f.watch.tick()
    expect(f.watch.state.sessions['2026-10-13']!.done).toBe(false)
  })

  it('rejects malformed counts rather than reporting completion', async () => {
    const f = fixture()
    f.batch(batch({ ready: true, pending_rows: -1 }))
    await f.watch.tick()
    expect(f.messages[0]).toContain('检查失败')
  })

  it('bounds the complete report when excluded product names contain long multibyte text', async () => {
    const f = fixture()
    f.batch(batch({ no_data_file: Array.from({ length: 10 }, (_, index) => pending(`${index}${'产品'.repeat(100)}`)),
      no_data_file_products: 10, no_data_file_rows: 10 }))
    await f.watch.tick()
    expect(Buffer.byteLength(f.messages[0]!, 'utf8')).toBeLessThanOrEqual(4096)
    expect(f.messages[0]).toContain('说明过长，仅展示汇总')
  })

  it('retries an outbox after completion without repeating checks or losing its report', async () => {
    const f = fixture()
    f.batch(batch({ ready: true, pending_rows: 0, pending_products: 0, pending: [] }))
    let fail = true
    f.adapters.send = async (content) => {
      if (fail) throw new Error('network unavailable')
      f.messages.push(content)
    }
    await f.watch.tick()
    const restored = createWatch(f.config, f.adapters, JSON.parse(f.saved.at(-1)!) as State)
    fail = false
    f.time('23:41')
    await restored.tick()
    expect(f.messages).toHaveLength(1)
    expect(f.call.mock.calls.filter(([name]) => name === 'check_daily_preopen')).toHaveLength(1)
    expect(restored.state.sessions['2026-10-13']!.outbox).toEqual([])
  })

  it('sends a final report when every batch was stale, and catches up after a missed entire window', async () => {
    const f = fixture()
    f.batch(batch({ is_today: false, age_seconds: 30_000 }))
    await f.watch.tick()
    f.time('2026-10-13T00:35:00+08:00')
    await f.watch.tick()
    expect(f.messages.at(-1)).toContain('整夜未取得有效监控批次')
    const missed = fixture()
    missed.time('2026-10-13T00:35:00+08:00')
    await missed.watch.tick()
    expect(missed.messages[0]).toContain('整夜未取得有效监控批次')
    expect(missed.call.mock.calls.map(([name]) => name)).toEqual(['get_trading_calendar'])
  })

  it('does not accept a check that completes after the deadline', async () => {
    const f = fixture()
    await f.watch.tick()
    f.time('2026-10-13T00:29:00+08:00')
    f.call.mockImplementation(async (name) => {
      if (name !== 'check_daily_preopen') throw new Error('unexpected')
      f.time('2026-10-13T00:30:00+08:00')
      return batch({ ready: true, pending_rows: 0, pending_products: 0, pending: [] })
    })
    await f.watch.tick()
    expect(f.messages.at(-1)).toContain('预开启未确认完成')
    expect(f.messages.join('\n')).not.toContain('已完成 ✅')
  })

  it('serializes overlapping ticks at a deferred remote read', async () => {
    const f = fixture()
    let resolveRead!: (value: Record<string, unknown>) => void
    const waiting = new Promise<Record<string, unknown>>((resolve) => { resolveRead = resolve })
    f.call.mockImplementation(async name => name === 'get_trading_calendar'
      ? { date: '2026-10-13', is_trading_day: true, estimated: false } : waiting)
    const first = f.watch.tick()
    const second = f.watch.tick()
    await vi.waitFor(() => { expect(f.call.mock.calls.filter(([name]) => name === 'check_daily_preopen')).toHaveLength(1) })
    resolveRead(batch())
    await Promise.all([first, second])
    expect(f.messages).toHaveLength(1)
    expect(f.call.mock.calls.filter(([name]) => name === 'check_daily_preopen')).toHaveLength(1)
  })
})

async function stalled(f: ReturnType<typeof fixture>) {
  for (const time of ['23:40', '23:41', '23:42']) { f.time(time); await f.watch.tick() }
}

describe('resumable pre-open triage', () => {
  it('resumes a saved run id after restart and poll failure, without dispatching another ps check', async () => {
    const f = fixture()
    await stalled(f)
    f.time('23:43')
    await f.watch.tick()
    expect(f.watch.state.sessions['2026-10-13']!.queue[0]!.runId).toBe('run-1')
    const restored = createWatch(f.config, f.adapters, JSON.parse(f.saved.at(-1)!) as State)
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (name, args) => {
      if (name === 'get_run_status') throw new Error('temporary polling failure')
      return original(name, args)
    })
    for (const time of ['23:44', '23:45', '23:46']) { f.time(time); await restored.tick() }
    expect(f.call.mock.calls.filter(([name]) => name === 'check_process_status')).toHaveLength(1)
    expect(restored.state.sessions['2026-10-13']!.queue).toEqual([])
    expect(f.messages.at(-1)).toContain('自动排查未完成')
  })

  it('drops old pending work when the current pending set changes', async () => {
    const f = fixture()
    await stalled(f)
    f.time('23:43')
    await f.watch.tick()
    f.batch(batch({ pending: [pending('DC51B')], pending_rows: 1 }))
    f.time('23:44')
    await f.watch.tick()
    expect(f.watch.state.sessions['2026-10-13']!.queue).toEqual([])
    expect(f.call.mock.calls.filter(([name]) => name === 'get_run_status')).toHaveLength(1)
  })

  it('records per-colo evidence and never counts another product process as this product', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (name, args) => {
      const colos = ['csc-sh-12', 'csc-sz-12']
      if (name === 'get_run_status') return { status: 'success', colos: colos.map(colo => ({ colo, returncode: 0, stdout: 'node other-portfolio.cfg' })) }
      if (name === 'get_strategy_start_errors') return { colos: colos.map(colo => ({ colo, ok: true, total_matched: 2,
        lines: ['2026-10-11T23:40:00+08:00 failed historical', '23:40:00 failed undated'], truncated: false })) }
      if (name === 'stat_colo_file') return { colos: colos.map(colo => ({ colo, ok: true, size: 100, mtime: '2026-10-12 23:40:00', line_count: 4 })) }
      return original(name, args)
    })
    await stalled(f)
    f.time('23:43')
    await f.watch.tick()
    const evidence = f.watch.state.sessions['2026-10-13']!.evidence[0]!
    expect(evidence.colos).toHaveLength(2)
    expect(evidence.summary).toContain('历史报错 1 条')
    expect(evidence.summary).toContain('时间未确认 1 条')
    expect(evidence.summary).not.toContain('未找到该产品进程')
    expect(f.messages.at(-1)).toMatchSnapshot()
  })

  it('retains successful colo evidence when the second colo repeatedly fails', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (name, args) => {
      if (name === 'get_run_status') return { status: 'failed', colos: [{ colo: 'csc-sh-12', returncode: 0, stdout: 'node hj1-portfolio.cfg' }] }
      if (name === 'get_strategy_start_errors') return { colos: [{ colo: 'csc-sh-12', ok: true, total_matched: 0, lines: [] }] }
      if (name === 'stat_colo_file') return { colos: [{ colo: 'csc-sh-12', ok: true, size: 1, line_count: 1 }] }
      return original(name, args)
    })
    await stalled(f)
    for (const time of ['23:43', '23:44', '23:45']) { f.time(time); await f.watch.tick() }
    expect(f.watch.state.sessions['2026-10-13']!.evidence[0]!.colos[0]).toMatchObject({ complete: true })
    expect(f.messages.at(-1)).toContain('部分 colo 结果缺失')
    expect(f.call.mock.calls.filter(([name]) => name === 'check_process_status')).toHaveLength(1)
  })

  it('expires a running check and does not repeat the same stall alert', async () => {
    const f = fixture()
    await stalled(f)
    for (const time of ['23:43', '23:46', '23:47']) { f.time(time); await f.watch.tick() }
    expect(f.messages.filter(message => message.includes('**预开启停滞告警**'))).toHaveLength(1)
    expect(f.messages.at(-1)).toContain('超过等待上限')
    expect(f.watch.state.sessions['2026-10-13']!.queue).toEqual([])
  })

  it('keeps prior evidence and detects a reduced log baseline after a new stall', async () => {
    const f = fixture()
    let size = 100
    let matched = 5
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (name, args) => {
      const colos = ['csc-sh-12', 'csc-sz-12']
      if (name === 'get_run_status') return { status: 'success', colos: colos.map(colo => ({ colo, returncode: 0, stdout: '' })) }
      if (name === 'get_strategy_start_errors') return { colos: colos.map(colo => ({ colo, ok: true, total_matched: matched, lines: [] })) }
      if (name === 'stat_colo_file') return { colos: colos.map(colo => ({ colo, ok: true, size, line_count: size })) }
      return original(name, args)
    })
    await stalled(f)
    f.time('23:43')
    await f.watch.tick()
    f.batch(batch({ pending_rows: 1, pending: [pending()] }))
    size = 10
    matched = 1
    for (const time of ['23:44', '23:45', '23:46', '23:47']) { f.time(time); await f.watch.tick() }
    expect(f.watch.state.sessions['2026-10-13']!.evidence).toHaveLength(2)
    expect(f.messages.at(-1)).toContain('日志可能发生截断或轮转')
  })

  it('ends file triage on a forbidden result without retrying or switching paths', async () => {
    const f = fixture()
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (name, args) => {
      if (name === 'get_run_status') return { status: 'success', colos: [] }
      if (name === 'stat_colo_file') return { colos: ['csc-sh-12', 'csc-sz-12'].map(colo => ({ colo, forbidden: true })) }
      return original(name, args)
    })
    await stalled(f)
    for (const time of ['23:43', '23:44']) { f.time(time); await f.watch.tick() }
    expect(f.call.mock.calls.filter(([name]) => name === 'stat_colo_file')).toHaveLength(1)
    expect(f.messages.at(-1)).toContain('停止该文件取证')
  })
})

describe('deployment plugin lifecycle', () => {
  it('awaits an in-flight guarded query on unload and leaves no timer or false failure report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preopen-plugin-'))
    roots.push(root)
    vi.useFakeTimers()
    vi.setSystemTime(at('23:40'))
    const send = vi.fn()
    let settle!: (result: object) => void
    const waiting = new Promise<object>((resolve) => { settle = resolve })
    let cleanup!: () => Promise<void>
    const execute = vi.fn(() => waiting)
    const ctx = {
      tools: { execute }, logger: { warn: vi.fn() }, provide: vi.fn(),
      weComNotifications: { enqueue: send },
      effect: (callback: () => () => Promise<void>) => { cleanup = callback() },
    }
    await apply(ctx, { stateDir: root })
    await vi.waitFor(() => { expect(execute).toHaveBeenCalledOnce() })
    const closing = cleanup()
    const input = execute.mock.calls[0]
    expect(input).toBeDefined()
    settle({ value: { content: [{ type: 'text', text: '{"date":"2026-10-13","is_trading_day":true,"estimated":false}' }] } })
    await closing
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect((await readState(root)).sessions).toEqual({})
  })

  it('ships the watcher disabled and derives secrets only from environment references', async () => {
    const source = await readFile(new URL('../deployments/trader-ops/config/dsh/trader-ops-bssh-ops-mcp.patch.yml', import.meta.url), 'utf8')
    // The loader owns !!js evaluation; this parser retains the expression as text.
    const rows = load(source.replaceAll('!!js ', '')) as { insert: { id: string; disabled: string; config: Record<string, unknown> }[] }[]
    const row = rows[0]!.insert.find(item => item.id === 'trader-ops-preopen-watch')!
    expect(row.disabled).toContain("TRADER_OPS_PREOPEN_WATCH_ENABLED !== '1'")
    expect(row.config).toMatchObject({ start: '23:40', end: '00:30' })
    expect(source).not.toContain('WEBHOOK')
  })
})

describe('deployment persistence and wire validation', () => {
  it('preserves the target date across midnight and uses natural-day evenings', () => {
    const config = fixture().config
    expect(windowAt(at('23:40'), config).session).toBe('2026-10-13')
    expect(windowAt(Date.parse('2026-10-13T00:01:00+08:00'), config).session).toBe('2026-10-13')
    expect(windowAt(Date.parse('2026-10-16T23:40:00+08:00'), config).session).toBe('2026-10-17')
  })

  it('rejects unsafe configuration and unknown state generations', () => {
    expect(() => resolveConfig({ stateDir: 'relative' })).toThrow('absolute')
    expect(() => resolveConfig({ stateDir: tmpdir(), start: '22:00' })).toThrow('window')
    expect(() => resolveConfig({ stateDir: tmpdir(), intervalMs: 0 })).toThrow('positive')
    expect(() => decodeState({ version: 2, sessions: {} })).toThrow('invalid saved state')
  })

  it('writes recoverable snapshots and refuses corrupted files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-preopen-'))
    roots.push(root)
    expect(await readState(root)).toEqual({ version: 1, sessions: {} })
    const f = fixture()
    await f.watch.tick()
    await writeState(root, f.watch.state)
    expect(await readState(root)).toEqual(f.watch.state)
    expect(await readFile(join(root, 'preopen-watch.v1.json'), 'utf8')).not.toContain('TraderAccount')
    await writeFile(join(root, 'preopen-watch.v1.json'), '{}')
    await expect(readState(root)).rejects.toThrow('invalid saved state')
  })

  it('unwraps real MCP envelopes and rejects error or non-JSON responses', () => {
    expect(remoteValue({ value: { content: [{ type: 'text', text: '{"run_id":"run-1"}' }] } })).toEqual({ run_id: 'run-1' })
    expect(remoteValue({ value: { structuredContent: { status: 'running' } } })).toEqual({ status: 'running' })
    expect(() => remoteValue({ isError: true })).toThrow('tool failed')
    expect(() => remoteValue({ value: { content: [{ type: 'text', text: 'bad' }] } })).toThrow()
  })

  it('does not classify timestamps with an unknown timezone or future timestamps as current failures', () => {
    expect(classifyLog(['2026-10-12 23:40:00 failed', '2026-10-13T23:40:00+08:00 failed'], at('23:40'), at('23:43')))
      .toContain('时间未确认 2 条')
  })

  it('includes startup failures before the first scheduled check in the same pre-open window', () => {
    const window = windowAt(at('23:40'), fixture().config)
    expect(classifyLog(['2026-10-12T23:38:00+08:00 failed'], window.evidenceStart, at('23:43')))
      .toContain('当夜报错 1 条')
  })
})
