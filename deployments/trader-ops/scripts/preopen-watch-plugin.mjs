/** Legacy Host watcher retained for controlled cutover to Agent-created Schedule tasks. */
import { randomUUID } from 'node:crypto'
import { createWatch, readState, resolveConfig, windowAt, writeState } from './preopen-watch.mjs'

export const inject = ['tools', 'weComNotifications']

const names = {
  get_trading_calendar: 'mcp__bssh-ops-remote__get_trading_calendar',
  check_daily_preopen: 'mcp__bssh-ops-remote__check_daily_preopen',
  check_process_status: 'mcp__bssh-ops-remote__check_process_status',
  get_run_status: 'mcp__bssh-ops-remote__get_run_status',
  get_strategy_start_errors: 'mcp__bssh-ops-remote__get_strategy_start_errors',
  list_colo_file_resources: 'mcp__bssh-ops-remote__list_colo_file_resources',
  stat_colo_file: 'mcp__bssh-ops-remote__stat_colo_file',
}

/** Extract JSON from the MCP envelope returned through the guarded tool runtime.
 * @param {object} result Tool runtime execution result.
 * @returns {object} Parsed remote response; failed or malformed envelopes throw.
 */
export function remoteValue(result) {
  if (result.isError) throw new Error('preopen-watch: read-only tool failed')
  const envelope = result.value
  if (envelope?.isError) throw new Error('preopen-watch: remote query failed')
  const value = envelope?.structuredContent ?? JSON.parse((envelope?.content ?? [])
    .filter(block => block.type === 'text').map(block => block.text).join('\n'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('preopen-watch: invalid remote response')
  return value
}

/** Activate one serialized watcher and await its work before Cordis unloads it.
 * @param {object} ctx Host tool registry and reversible effect owner.
 * @param {object} input Deployment configuration, including private stateDir.
 * @returns {Promise<void>} Resolves after persisted state and lifecycle effects are installed.
 */
export async function apply(ctx, input) {
  const config = resolveConfig(input)
  const controller = new AbortController()
  let timer
  let work = Promise.resolve()
  const watch = createWatch(config, {
    now: Date.now,
    cancelled: () => controller.signal.aborted,
    save: state => writeState(config.stateDir, state),
    call: async (name, args) => {
      if (!Object.hasOwn(names, name)) throw new Error('preopen-watch: unsupported read-only query')
      controller.signal.throwIfAborted()
      const window = windowAt(Date.now(), config)
      const timeoutMs = Date.now() >= window.start && Date.now() < window.deadline
        ? Math.min(config.toolTimeoutMs, window.deadline - Date.now()) : config.toolTimeoutMs
      const result = await ctx.tools.execute({
        callId: `preopen-watch:${randomUUID()}`, name: names[name], arguments: args,
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
      })
      controller.signal.throwIfAborted()
      return remoteValue(result)
    },
    send: async content => {
      controller.signal.throwIfAborted()
      await ctx.weComNotifications.enqueue(content)
    },
  }, await readState(config.stateDir))
  ctx.provide('traderOpsPreopenWatch', watch)
  ctx.effect(() => {
    const poll = () => {
      if (controller.signal.aborted) return
      work = watch.tick().catch(() => { ctx.logger.warn('preopen-watch: tick failed; saved work will retry') })
        .finally(() => {
          if (!controller.signal.aborted) {
            const now = Date.now()
            const window = windowAt(now, config)
            const deadlines = [window.start, window.deadline,
              ...Object.values(watch.state.sessions).filter(session => !session.done).map(session => session.deadline)]
              .filter(at => at > now)
            const delay = Math.min(config.intervalMs - now % config.intervalMs,
              ...deadlines.map(at => at - now))
            timer = setTimeout(poll, delay)
          }
        })
    }
    poll()
    return async () => {
      controller.abort(new Error('preopen-watch disposed'))
      clearTimeout(timer)
      await work
    }
  })
}
