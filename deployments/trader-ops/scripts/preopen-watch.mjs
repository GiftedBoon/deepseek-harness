/** Legacy deployment pre-open engine retained until Agent-task cutover is validated. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const DAY = 86_400_000
const OFFSET = 8 * 60 * 60 * 1000
const RESET_CHECK_LINES = [
  '**归零检查：以下 13 项均为 0**',
  '> PnLratio、netMVRatio、Posratio、TradePnLratio、TradeFeeratio',
  '> MV_shortSell、MV_net',
  '> traderUnRealizedTradePnL、traderRealizedTradePnL',
  '> traderTradePnL、traderPositionPnL、traderTotalPnL',
  '> traderTradingCost',
]
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const text = value => String(value ?? '—').replace(/[\r\n\x00-\x1f]/g, ' ').slice(0, 160)

/** Resolve deployment tunables, rejecting invalid times and limits at activation.
 * @param {object} input Deployment configuration.
 * @returns {object} Complete validated configuration.
 */
export function resolveConfig(input = {}) {
  const config = {
    start: '23:40', end: '00:30', logWindowStart: '23:30', intervalMs: 60_000, freshSeconds: 180,
    stallRepeats: 3, productsPerCheck: 2, retries: 3, processWaitMs: 180_000,
    toolTimeoutMs: 75_000, maxDetailRows: 200,
    retentionDays: 30, catchupEnd: '12:00',
    expectedExcluded: ['GSLS4', 'JPMLS2', 'MSLS2', 'SHORTMSBOXLS1', 'SHORTMSBOXLS2', 'UBSLS2'],
    ...input,
  }
  for (const key of ['start', 'end', 'logWindowStart', 'catchupEnd']) {
    if (typeof config[key] !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(config[key])) {
      throw new Error(`preopen-watch: ${key} must be HH:mm`)
    }
  }
  if (config.start < '23:30' || config.end > '01:00') throw new Error('preopen-watch: window must stay within 23:30–01:00')
  if (config.logWindowStart < '23:30' || config.logWindowStart > config.start) throw new Error('preopen-watch: logWindowStart must be within 23:30–start')
  if (config.catchupEnd <= config.end || config.catchupEnd > '12:00') throw new Error('preopen-watch: catchupEnd must follow end and be at or before noon')
  for (const key of ['intervalMs', 'freshSeconds', 'stallRepeats', 'productsPerCheck', 'retries',
    'processWaitMs', 'toolTimeoutMs', 'maxDetailRows', 'retentionDays']) {
    if (!count(config[key]) || config[key] === 0) throw new Error(`preopen-watch: ${key} must be a positive integer`)
  }
  if (config.intervalMs < 60_000) throw new Error('preopen-watch: intervalMs must be at least 60000')
  if (!isAbsolute(config.stateDir ?? '')) throw new Error('preopen-watch: stateDir must be absolute')
  if (!Array.isArray(config.expectedExcluded) || !config.expectedExcluded.every(item => typeof item === 'string')) {
    throw new Error('preopen-watch: expectedExcluded must be a string array')
  }
  return config
}

/** Compute the target natural date and its Beijing window; never skip forward to a trading day.
 * @param {number} now Current instant in milliseconds.
 * @param {object} config Resolved window settings.
 * @returns {object} Target date and absolute start/deadline.
 */
export function windowAt(now, config) {
  const local = new Date(now + OFFSET)
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - OFFSET
  const target = midnight + (local.getUTCHours() >= 12 ? DAY : 0)
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  return {
    session: new Date(target + OFFSET).toISOString().slice(0, 10),
    start: target - DAY + minutes(config.start) * 60_000,
    evidenceStart: target - DAY + minutes(config.logWindowStart) * 60_000,
    deadline: target + minutes(config.end) * 60_000,
  }
}

function validateBatch(value) {
  if (!object(value)) throw new Error('invalid monitoring response')
  for (const key of ['total_rows', 'total_products', 'pending_rows', 'pending_products', 'missing_rows',
    'no_data_file_products', 'no_data_file_rows', 'not_reporting_rows']) {
    if (!count(value[key])) throw new Error('invalid monitoring counts')
  }
  if (value.pending_rows > value.total_rows || value.pending_products > value.total_products
    || value.ready !== (value.total_rows > 0 && value.pending_rows === 0)
    || typeof value.previous_batch_compared !== 'boolean' || typeof value.is_today !== 'boolean'
    || typeof value.pending_truncated !== 'boolean' || typeof value.no_data_file_truncated !== 'boolean'
    || !(value.create_time === null || typeof value.create_time === 'string')
    || !(value.age_seconds === null || count(value.age_seconds))) throw new Error('inconsistent monitoring response')
  for (const key of ['pending', 'no_data_file']) {
    if (!Array.isArray(value[key]) || !value[key].every(row => object(row)
      && ['NAME', 'Colo', 'Index'].every(field => typeof row[field] === 'string')
      && (row.Exchange === null || typeof row.Exchange === 'string'))) throw new Error('invalid monitoring details')
  }
  return value
}

function safeBatch(batch) {
  const result = {}
  for (const key of ['ready', 'create_time', 'age_seconds', 'total_rows', 'total_products', 'pending_rows',
    'pending_products', 'missing_rows', 'previous_batch_compared', 'no_data_file_products', 'not_reporting_rows']) {
    result[key] = batch[key]
  }
  return result
}

function report(title, state, now, reason = '', details = []) {
  const b = state.lastBatch
  const lines = [`**${title}**`, `目标交易日：${state.session}`,
    `检查时间：${new Date(now + OFFSET).toISOString().slice(0, 19).replace('T', ' ')}（北京时间）`]
  if (b) {
    lines.push(`批次：${text(b.create_time)}（延迟 ${b.age_seconds ?? '—'} 秒）`,
      `范围：${b.total_rows} 行 / ${b.total_products} 产品｜待开启：${b.pending_rows} 行 / ${b.pending_products} 产品`)
    if (title === '结论：已完成 ✅') {
      lines.push(...RESET_CHECK_LINES)
    }
    if (b.missing_rows > 0) lines.push(`缺失记录：${b.missing_rows} 行，无法确认完成。`)
    if (!b.previous_batch_compared) lines.push('上一批比对未完成，无法确认完成。')
    if (b.no_data_file_products > 0) lines.push(`已排除 ${b.no_data_file_products} 个无数据文件产品。`)
    if (b.not_reporting_rows > 0) lines.push(`上报卡住：${b.not_reporting_rows} 行，零值可能陈旧，不代表实际就绪。`)
  }
  if (reason) lines.push(Buffer.byteLength([...lines, reason].join('\n'), 'utf8') <= 3600
    ? reason : '说明过长，仅展示汇总。')
  for (const detail of details) {
    if (Buffer.byteLength([...lines, detail].join('\n'), 'utf8') > 3800) {
      lines.push('仅展示部分排查结果，完整摘要已保存。')
      break
    }
    lines.push(detail)
  }
  if (state.truncated) lines.push('待开启明细已截断，排查仅覆盖返回的产品。')
  return lines.join('\n')
}

function initial(window) {
  return { ...window, checks: 0, done: false, signature: null, repeats: 0, alerted: null,
    lastTick: null, lastBatch: null, lastFreshAt: null, queue: [], evidence: [], excludedProblem: false,
    calendarPending: false, truncated: false,
    outbox: [], deliveries: [], notices: [] }
}

function validEvidence(rows) {
  return Array.isArray(rows) && rows.every(row => object(row) && typeof row.colo === 'string' && count(row.at)
    && (row.forbidden === true || row.complete === false || (row.complete === true
      && typeof row.processHint === 'boolean' && count(row.totalMatched) && typeof row.file === 'string'
      && (row.size === null || count(row.size)) && (row.lineCount === null || count(row.lineCount))
      && (row.mtime === null || typeof row.mtime === 'string')
      && typeof row.classification === 'string' && typeof row.comparison === 'string')))
}

/** Validate a saved generation before resuming timers or dispatching tools.
 * @param {object} value JSON read from the deployment state file.
 * @returns {object} Validated version-one state.
 */
export function decodeState(value) {
  if (!object(value) || value.version !== 1 || !object(value.sessions)) throw new Error('preopen-watch: invalid saved state')
  for (const [day, s] of Object.entries(value.sessions)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !object(s) || s.session !== day
      || !count(s.start) || !count(s.evidenceStart) || s.evidenceStart > s.start
      || !count(s.deadline) || s.deadline <= s.start || !count(s.checks)
      || typeof s.done !== 'boolean' || typeof s.excludedProblem !== 'boolean' || !count(s.repeats)
      || typeof s.calendarPending !== 'boolean' || typeof s.truncated !== 'boolean'
      || ![s.signature, s.alerted].every(x => x === null || typeof x === 'string')
      || ![s.lastTick, s.lastFreshAt].every(x => x === null || count(x))
      || !Array.isArray(s.queue) || !Array.isArray(s.evidence) || !Array.isArray(s.outbox)
      || !Array.isArray(s.notices) || !s.notices.every(x => typeof x === 'string')) throw new Error('preopen-watch: invalid saved session')
    if (s.lastBatch !== null && (!object(s.lastBatch)
      || !['total_rows', 'total_products', 'pending_rows', 'pending_products', 'missing_rows',
        'no_data_file_products', 'not_reporting_rows'].every(k => count(s.lastBatch[k]))
      || typeof s.lastBatch.previous_batch_compared !== 'boolean')) throw new Error('preopen-watch: invalid saved batch')
    for (const task of s.queue) {
      if (!object(task) || typeof task.product !== 'string' || !Array.isArray(task.colos)
        || !task.colos.every(x => typeof x === 'string') || !count(task.attempts)
        || ![task.runId].every(x => x === null || typeof x === 'string')
        || !(task.startedAt === null || count(task.startedAt))
        || (task.runId === null) !== (task.startedAt === null)
        || (task.colosEvidence !== undefined && !validEvidence(task.colosEvidence))) throw new Error('preopen-watch: invalid saved triage')
    }
    if (!s.evidence.every(x => object(x) && typeof x.product === 'string' && typeof x.summary === 'string' && count(x.at) && validEvidence(x.colos))
      || !s.outbox.every(x => object(x) && typeof x.id === 'string' && typeof x.content === 'string'
        && Buffer.byteLength(x.content, 'utf8') <= 4096 && count(x.attempts))) {
      throw new Error('preopen-watch: invalid saved report')
    }
    if (!Array.isArray(s.deliveries) || !s.deliveries.every(x => object(x)
      && typeof x.id === 'string' && count(x.sentAt) && count(x.attempts))) throw new Error('preopen-watch: invalid saved delivery')
  }
  return value
}

/** Serialize minute checks and delivery; adapters own policy-routed queries and bounded transport.
 * @param {object} config Complete deployment configuration.
 * @param {object} adapters call(name,args), save(state), send(content), and now().
 * @param {object} state Validated saved state, or a new empty generation.
 * @returns {object} tick() and state for the Host lifecycle owner.
 */
export function createWatch(config, adapters, state = { version: 1, sessions: {} }) {
  decodeState(state)
  let tail = Promise.resolve()
  const cancelled = () => adapters.cancelled?.() === true
  const save = () => adapters.save(state)
  const enqueue = (s, content) => s.outbox.push({ id: randomUUID(), content, attempts: 0 })
  const notice = (s, key, content) => {
    if (s.notices.includes(key)) return
    s.notices.push(key)
    enqueue(s, content)
  }
  const deliver = async () => {
    for (const s of Object.values(state.sessions).sort((a, b) => b.session.localeCompare(a.session))) {
      if (cancelled()) return
      const item = s.outbox[0]
      if (!item) continue
      item.attempts += 1
      await save()
      try { await adapters.send(item.content) }
      catch (error) { /* The persisted outbox retries next tick; transport diagnostics never enter reports. */ return }
      s.outbox.shift()
      s.deliveries.push({ id: item.id, sentAt: adapters.now(), attempts: item.attempts })
      await save()
      return
    }
  }
  const finish = s => {
    const now = adapters.now()
    const reason = s.lastFreshAt === null ? '整夜未取得有效监控批次。'
      : now - s.lastFreshAt > config.freshSeconds * 1000 ? '监控数据中断；展示的是最后取得的批次，不能代表当前状态。'
        : s.lastBatch?.total_rows === 0 ? '检查范围为空，无法确认完成。'
        : '到达窗口截止，仍未确认完成。'
    enqueue(s, report('预开启未确认完成', s, now,
      `${reason}\n最后有效检查时间：${s.lastFreshAt === null ? '—' : new Date(s.lastFreshAt + OFFSET).toISOString().slice(0, 19).replace('T', ' ')}\n尚待排查：${s.queue.length} 个产品。`,
      s.evidence.slice(-config.productsPerCheck).map(e => `> ${text(e.product)}：${e.summary}`)))
    s.done = true
  }
  const abandon = s => {
    for (const task of s.queue) {
      if (task.runId !== null || task.colosEvidence?.length) s.evidence.push({
        product: task.product, at: adapters.now(), runId: task.runId, colos: task.colosEvidence ?? [],
        summary: '待开启状态变化，旧排查已中止；历史取证不代表当前状态。',
      })
    }
    s.queue = []
  }
  const triage = async s => {
    const completed = []
    for (const task of s.queue.slice(0, config.productsPerCheck)) {
      if (cancelled() || adapters.now() >= s.deadline) break
      let observation
      let evidence = []
      try {
        if (task.runId === null) {
          const result = await adapters.call('check_process_status', { colos: task.colos })
          if (typeof result.run_id !== 'string' || !result.run_id) throw new Error('invalid run id')
          task.runId = result.run_id
          task.startedAt = adapters.now()
          await save()
        }
        const run = await adapters.call('get_run_status', { run_id: task.runId })
        if (adapters.now() >= s.deadline) break
        if (['pending', 'running', 'queued'].includes(run.status)) {
          if (adapters.now() - task.startedAt < config.processWaitMs) continue
          observation = '进程检查超过等待上限，原因未确认。'
        } else {
          if (!Array.isArray(run.colos)) throw new Error('invalid process result')
          const logs = await adapters.call('get_strategy_start_errors', { product: task.product })
          if (!Array.isArray(logs.colos)) throw new Error('invalid log result')
          const resources = await adapters.call('list_colo_file_resources', {})
          if (!resources.resources?.some(row => row.resource_id === 'strategy_log')) throw new Error('strategy log resource unavailable')
          const files = await adapters.call('stat_colo_file', { product: task.product, resource_id: 'strategy_log' })
          if (!Array.isArray(files.colos)) throw new Error('invalid log file result')
          if (adapters.now() >= s.deadline) break
          const previous = s.evidence.findLast(row => row.product === task.product && row.colos?.length)
          const result = processEvidence(task, run, logs, files, s.evidenceStart, adapters.now(), previous)
          evidence = result.colos
          task.colosEvidence = evidence
          await save()
          if (!result.complete) throw new Error('partial evidence')
          observation = result.summary
        }
      } catch (error) {
        if (cancelled()) break
        task.attempts += 1
        // Poll failures preserve a known run id; no second process check is dispatched.
        if (task.attempts < config.retries) { await save(); continue }
        observation = '自动排查未完成：只读取证连续失败或部分 colo 结果缺失，原因未确认。'
      }
      const e = { product: task.product, at: adapters.now(), summary: observation, runId: task.runId,
        colos: evidence.length ? evidence : task.colosEvidence ?? [] }
      s.evidence.push(e)
      completed.push(e)
      s.queue.splice(s.queue.indexOf(task), 1)
      await save()
    }
    if (completed.length) enqueue(s, report('预开启自动排查', s, adapters.now(),
      `本次排查 ${completed.length} 个产品；仍待排查 ${s.queue.length} 个。自动排查只读取证，未执行修复。`,
      completed.map(e => `> ${text(e.product)}：${e.summary}`)))
  }
  const check = async s => {
    let b
    s.checks += 1
    try { b = validateBatch(await adapters.call('check_daily_preopen', { max_detail_rows: config.maxDetailRows })) }
    catch (error) {
      if (cancelled()) return
      notice(s, 'check-failed', report('结论：检查失败', s, adapters.now(), '未取得可验证的监控结果，将继续复查。'))
      return
    }
    if (adapters.now() >= s.deadline) return
    s.lastBatch = safeBatch(b)
    if (!b.is_today || b.create_time === null || b.age_seconds === null || b.age_seconds > config.freshSeconds) {
      notice(s, 'stale', report('结论：数据过期', s, adapters.now(), '无法确认预开启状态，将继续复查。'))
      return
    }
    s.lastFreshAt = adapters.now()
    if (b.total_rows === 0) {
      notice(s, 'empty', report('结论：无法判断', s, adapters.now(), '检查范围为空，将继续复查。'))
      return
    }
    const unexpected = b.no_data_file.filter(row => !config.expectedExcluded.includes(row.NAME))
    s.excludedProblem = unexpected.length > 0 || b.no_data_file_truncated
    if (s.excludedProblem) notice(s, 'excluded', report('预开启排除名单待核验', s, adapters.now(),
      unexpected.length ? `非预期排除产品：${unexpected.slice(0, 10).map(row => text(row.NAME)).join('、')}。${unexpected.length > 10 ? '仅列前 10 个。' : ''}` : '排除名单明细截断，尚未核验全部排除产品。'))
    if (b.ready && b.previous_batch_compared && b.missing_rows === 0 && !s.excludedProblem) {
      enqueue(s, report('结论：已完成 ✅', s, adapters.now(), `共检查 ${s.checks} 次；本次检查范围内的预开启判据已通过，当夜守护结束。`))
      s.done = true
      abandon(s)
      return
    }
    if (b.pending_rows === 0) {
      notice(s, 'unconfirmed', report('结论：无法确认完成', s, adapters.now(), '待开启为零，但比对或排除名单尚未通过核验，将继续复查。'))
      return
    }
    const signature = createHash('sha256').update(JSON.stringify([
      b.pending_rows, b.pending_products, b.pending.map(row => [row.NAME, row.Colo, row.Exchange]),
    ])).digest('hex')
    if (signature !== s.signature) {
      s.signature = signature
      s.repeats = 1
      s.alerted = null
      abandon(s)
      s.truncated = b.pending_truncated
      enqueue(s, report('结论：未完成', s, adapters.now(), '将每分钟复查，确认完成后播报。'))
      return
    }
    s.repeats += 1
    if (s.repeats >= config.stallRepeats && s.alerted !== signature) {
      s.alerted = signature
      const products = new Map()
      for (const row of b.pending) {
        if (!products.has(row.NAME)) products.set(row.NAME, new Set())
        products.get(row.NAME).add(row.Colo)
      }
      s.queue = [...products].map(([product, colos]) => ({ product, colos: [...colos], runId: null, startedAt: null, attempts: 0 }))
      enqueue(s, report('预开启停滞告警', s, adapters.now(), `连续 ${config.stallRepeats} 次待开启集合无变化，下一轮开始自动只读排查。`))
    } else if (s.alerted === signature && s.queue.length) await triage(s)
  }
  const tick = async () => {
    if (cancelled()) return
    const now = adapters.now()
    for (const s of Object.values(state.sessions)) if (!s.done && now >= s.deadline) finish(s)
    const window = windowAt(now, config)
    if (now >= window.start && now < window.deadline) {
      let s = state.sessions[window.session]
      if (!s) {
        try {
          const calendar = await adapters.call('get_trading_calendar', { at: `${window.session}T12:00:00+08:00` })
          if (calendar.date === window.session && calendar.is_trading_day === true && calendar.estimated === false) {
            s = initial(window)
            state.sessions[window.session] = s
          } else if (calendar.estimated !== false || calendar.date !== window.session || typeof calendar.is_trading_day !== 'boolean') {
            s = initial(window)
            s.done = true
            state.sessions[window.session] = s
            enqueue(s, report('交易日未核验', s, now, '无法核验节假日交易状态，本夜未启动预开启检查。'))
          }
        } catch (error) {
          if (cancelled()) return
          // Calendar failures remain retryable and are reported without exposing transport details.
          s = initial(window)
          state.sessions[window.session] = s
          s.calendarPending = true
          notice(s, 'calendar', report('交易日未核验', s, now, '交易日历查询失败，将继续核验。'))
        }
      }
      if (s?.calendarPending) {
        try {
          const calendar = await adapters.call('get_trading_calendar', { at: `${s.session}T12:00:00+08:00` })
          if (calendar.date === s.session && calendar.estimated === false && typeof calendar.is_trading_day === 'boolean') {
            s.calendarPending = false
            if (!calendar.is_trading_day) s.done = true
          }
        } catch (error) { /* Retain calendarPending for the next independent minute check. */ }
      }
      if (s && !s.done && !s.calendarPending && (s.lastTick === null || now - s.lastTick >= config.intervalMs)) {
        s.lastTick = now
        await save()
        await check(s)
      }
    }
    const localTime = new Date(now + OFFSET).toISOString().slice(11, 16)
    if (now >= window.deadline && localTime < config.catchupEnd && !state.sessions[window.session]) {
      try {
        const calendar = await adapters.call('get_trading_calendar', { at: `${window.session}T12:00:00+08:00` })
        if (calendar.date === window.session && calendar.estimated === false && typeof calendar.is_trading_day === 'boolean') {
          const s = initial(window)
          state.sessions[window.session] = s
          if (calendar.is_trading_day) finish(s)
          else s.done = true
        }
      } catch (error) { /* Retry missed-window calendar verification on the next Host tick. */ }
    }
    // A remote read can span the deadline; completion is never accepted after it.
    for (const s of Object.values(state.sessions)) if (!s.done && adapters.now() >= s.deadline) finish(s)
    for (const [day, s] of Object.entries(state.sessions)) {
      if (s.done && !s.outbox.length && now - s.deadline > config.retentionDays * DAY) delete state.sessions[day]
    }
    await save()
    await deliver()
  }
  return { state, tick: () => {
    const pending = tail.then(tick)
    tail = pending.catch(() => {})
    return pending
  } }
}

function processEvidence(task, run, logs, files, start, now, previous) {
  const summaries = []
  const colos = []
  let complete = true
  for (const colo of task.colos) {
    const ps = run.colos.find(row => row.colo === colo)
    const log = logs.colos.find(row => row.colo === colo)
    const file = files.colos.find(row => row.colo === colo)
    if (file?.forbidden === true) {
      colos.push({ colo, at: now, forbidden: true })
      summaries.push(`${text(colo)}：日志文件读取被拒绝，停止该文件取证，原因未确认`)
      continue
    }
    if (!ps || ps.returncode !== 0 || typeof ps.stdout !== 'string' || !log || log.ok !== true
      || !count(log.total_matched) || !Array.isArray(log.lines) || !log.lines.every(x => typeof x === 'string')
      || !file || file.ok !== true
      || !(file.size === null || file.size === undefined || count(file.size))
      || !(file.line_count === null || file.line_count === undefined || count(file.line_count))
      || !(file.mtime === null || file.mtime === undefined || typeof file.mtime === 'string')) {
      complete = false
      colos.push({ colo, at: now, complete: false })
      summaries.push(`${text(colo)}：取证未完成`)
      continue
    }
    // Only an exact product portfolio/log filename identifies this process; ps summaries remain unconfirmed.
    const escaped = task.product.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const matched = new RegExp(`(?:^|[\\s/])(?:a-t0-${escaped}\\.log|${escaped}-portfolio\\.cfg)(?=$|[\\s])`, 'i').test(ps.stdout)
    const classification = classifyLog(log.lines, start, now)
    const old = previous?.colos.find(row => row.colo === colo && row.complete)
    const reset = old && (log.total_matched < old.totalMatched || file.size < old.size || file.line_count < old.lineCount)
    const comparison = reset ? '日志可能发生截断或轮转，基线已重新记录'
      : old ? '匹配总数仅作参考，文件替换不能仅凭数量判断' : '已记录首次取证基线'
    colos.push({ colo, at: now, complete: true, processHint: matched, totalMatched: log.total_matched,
      file: `a-t0-${task.product.toLowerCase()}.log`, size: file.size ?? null, mtime: file.mtime ?? null,
      lineCount: file.line_count ?? null, missing: file.missing === true,
      classification, comparison, truncated: log.truncated === true })
    summaries.push(`${text(colo)}：${matched ? '发现该产品进程线索，仍需核对上报' : '进程输出未确认该产品，不能据此判定未启动'}；${file.missing === true ? '日志文件不存在' : classification}；failed 匹配总数 ${log.total_matched}；${comparison}，原因未确认`)
  }
  return { complete, summary: summaries.join('；'), colos }
}

/** Classify dated failed lines without retaining or publishing raw log content.
 * @param {string[]} lines Retrieved failed lines.
 * @param {number} start Pre-open window start.
 * @param {number} now Latest accepted evidence time.
 * @returns {string} Time evidence summary; undated lines remain unconfirmed.
 */
export function classifyLog(lines, start, now) {
  const counts = { current: 0, old: 0, unknown: 0 }
  for (const line of lines) {
    const match = /\b(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)(Z|[+-]\d{2}:\d{2})?/.exec(line)
    // A missing offset cannot establish the log's timezone.
    const at = match?.[3] ? Date.parse(`${match[1]}T${match[2]}${match[3]}`) : NaN
    if (!Number.isFinite(at) || at > now) counts.unknown += 1
    else if (at >= start) counts.current += 1
    else counts.old += 1
  }
  return lines.length === 0 ? '未返回 failed 行，不代表启动成功'
    : `当夜报错 ${counts.current} 条、历史报错 ${counts.old} 条、时间未确认 ${counts.unknown} 条（仅统计返回明细）`
}

/** Read a private state file; malformed generations fail rather than silently reset.
 * @param {string} directory Deployment-owned state directory.
 * @returns {Promise<object>} Version-one state.
 */
export async function readState(directory) {
  let source
  try { source = await readFile(join(directory, 'preopen-watch.v1.json'), 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT') return { version: 1, sessions: {} }
    throw error
  }
  return decodeState(JSON.parse(source))
}

/** Atomically replace one validated state snapshot in a private deployment directory.
 * @param {string} directory Deployment-owned state directory.
 * @param {object} state Version-one state to persist.
 * @returns {Promise<void>} Resolves after the replacement.
 */
export async function writeState(directory, state) {
  decodeState(state)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `preopen-watch-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' })
  await rename(temporary, join(directory, 'preopen-watch.v1.json'))
}
