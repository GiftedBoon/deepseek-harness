/** Durable execution of deployment-allowlisted tools for mapped WeCom conversations. */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ResolvedConfig, ScheduledActionConfig } from './config.ts'
import type { ChannelWeComDomain } from './domain.ts'
import type { ScheduledActionRecord, WeComScheduledActionDomain } from './scheduled-action-domain.ts'

const MAX_TIMER_DELAY_MS = 2_147_483_647
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const SAFE_ARGUMENT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/

interface ResolvedAction {
  readonly id: string
  readonly description: string
  readonly toolName: string
  readonly targetArgument: string
  readonly targetArgumentFormat: 'scalar' | 'singleton-array'
  readonly targetPattern: RegExp
  readonly arguments: Readonly<Record<string, JsonValue>>
  readonly fingerprint: string
}

interface ScheduledActionsOptions {
  readonly config: ResolvedConfig
  readonly conversations: ChannelWeComDomain
  readonly actions: WeComScheduledActionDomain
  readonly enqueueNotification: (target: string, content: string) => Promise<void>
}

/** Public projection returned by the three management tools. */
interface ScheduledActionView extends Record<string, JsonValue> {
  readonly id: string
  readonly action: string
  readonly target: string
  readonly runAt: string
  readonly state: 'scheduled' | 'running'
}

/** Stable model-facing management failure. */
interface ScheduledActionError extends Record<string, JsonValue> {
  readonly code: string
  readonly message: string
}

/**
 * Validate and freeze the deployment action allowlist.
 *
 * @param configs - Operator-owned scheduled-action definitions.
 * @returns Definitions indexed by their model-facing action ids.
 */
export function resolveScheduledActions(configs: readonly ScheduledActionConfig[]): ReadonlyMap<string, ResolvedAction> {
  const result = new Map<string, ResolvedAction>()
  for (const [index, config] of configs.entries()) {
    const label = `channel-wecom: scheduledActions[${index}]`
    if (!SAFE_ID.test(config.id)) throw new Error(`${label}.id must be a safe non-empty identifier`)
    if (result.has(config.id)) throw new Error(`${label}.id duplicates "${config.id}"`)
    if (config.description.trim() === '') throw new Error(`${label}.description must be non-empty`)
    if (config.toolName.trim() === '') throw new Error(`${label}.toolName must be non-empty`)
    if (!SAFE_ARGUMENT_NAME.test(config.targetArgument)) {
      throw new Error(`${label}.targetArgument must be a top-level JavaScript identifier`)
    }
    const targetArgumentFormat = (config as { readonly targetArgumentFormat?: string }).targetArgumentFormat ?? 'scalar'
    if (targetArgumentFormat !== 'scalar' && targetArgumentFormat !== 'singleton-array') {
      throw new Error(`${label}.targetArgumentFormat must be scalar or singleton-array`)
    }
    let targetPattern: RegExp
    try {
      targetPattern = new RegExp(config.targetPattern)
    } catch (error: unknown) {
      throw new Error(`${label}.targetPattern is invalid`, { cause: error })
    }
    if (!config.targetPattern.startsWith('^') || !config.targetPattern.endsWith('$')) {
      throw new Error(`${label}.targetPattern must be anchored with ^ and $`)
    }
    const detached = snapshotJsonValue(config.arguments === undefined ? {} : config.arguments)
    if (detached === undefined || detached === null || typeof detached !== 'object' || Array.isArray(detached)) {
      throw new Error(`${label}.arguments must be a lossless-JSON object`)
    }
    if (Object.hasOwn(detached, config.targetArgument)) {
      throw new Error(`${label}.arguments must not define targetArgument "${config.targetArgument}"`)
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({
      toolName: config.toolName,
      targetArgument: config.targetArgument,
      targetArgumentFormat,
      targetPattern: config.targetPattern,
      arguments: detached,
    })).digest('hex')
    result.set(config.id, Object.freeze({
      id: config.id,
      description: config.description,
      toolName: config.toolName,
      targetArgument: config.targetArgument,
      targetArgumentFormat,
      targetPattern,
      arguments: Object.freeze(detached as Record<string, JsonValue>),
      fingerprint,
    }))
  }
  return result
}

/** Convert a validated fixed UTC offset to milliseconds. */
function parseOffset(value: string): number {
  if (value === 'Z') return 0
  const sign = value[0] === '+' ? 1 : -1
  return sign * (Number(value.slice(1, 3)) * 60 + Number(value.slice(4, 6))) * 60_000
}

/** Parse an explicit offset date-time or the next occurrence of a time-only value. */
function parseRunAt(value: string, now: number, configuredOffset: string): number | undefined {
  const timeOnly = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (timeOnly !== null) {
    const hour = Number(timeOnly[1])
    const minute = Number(timeOnly[2])
    const second = Number(timeOnly[3] ?? 0)
    if (hour > 23 || minute > 59 || second > 59) return undefined
    const offset = parseOffset(configuredOffset)
    const localNow = new Date(now + offset)
    let candidate = Date.UTC(
      localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute, second,
    ) - offset
    if (candidate <= now) candidate += 86_400_000
    return candidate
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value)
  if (match === null) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'))
  if (month < 1 || month > 12 || hour > 23
    || minute > 59 || second > 59) return undefined
  const local = new Date(0)
  local.setUTCFullYear(year, month - 1, day)
  local.setUTCHours(hour, minute, second, millisecond)
  if (local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return undefined
  const offsetHour = Number(match[10] ?? 0)
  const offsetMinute = Number(match[11] ?? 0)
  if (offsetHour > 23 || offsetMinute > 59) return undefined
  const offsetSign = match[8] === 'Z' ? 0 : match[9] === '+' ? 1 : -1
  return local.getTime() - offsetSign * (offsetHour * 60 + offsetMinute) * 60_000
}

function view(id: string, record: ScheduledActionRecord): ScheduledActionView {
  return {
    id,
    action: record.actionId,
    target: record.target,
    runAt: new Date(record.runAt).toISOString(),
    state: record.state === 'pending' ? 'scheduled' : 'running',
  }
}

function renderJson(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function error(code: string, message: string): ScheduledActionError {
  return { code, message }
}

/** Own timers, recovery, management tools, policy-routed dispatch, and durable notifications. */
export class WeComScheduledActions {
  private readonly definitions: ReadonlyMap<string, ResolvedAction>
  private readonly controller = new AbortController()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly executions = new Set<Promise<void>>()
  private stateTail = Promise.resolve()
  private started = false

  /**
   * @param ctx - Global tool registry and logger.
   * @param options - Resolved channel configuration, storage, and notification sink.
   */
  constructor(private readonly ctx: Context, private readonly options: ScheduledActionsOptions) {
    this.definitions = resolveScheduledActions(options.config.scheduledActions)
  }

  /**
   * Recover pending tasks without repeating a task that crossed its dispatch commit point.
   *
   * @returns A promise that settles after persisted tasks have been classified and rearmed.
   */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    const table = this.options.actions.table('actions')
    for (const [id, record] of table.entries()) {
      if (record.state === 'pending') {
        this.arm(id, record.runAt)
        continue
      }
      const conversation = this.options.conversations.table('conversations').get(record.conversationKey)
      if (conversation !== undefined) {
        await this.options.enqueueNotification(
          conversation.target,
          this.notification(this.options.config.messages.scheduledActionUncertain, record),
        )
      }
      await table.delete(id)
    }
  }

  /**
   * Remove timers, abort background calls, and await their quiescence.
   *
   * @returns A promise that settles when all owned execution and persistence work is quiescent.
   */
  async close(): Promise<void> {
    this.controller.abort(new Error('channel-wecom scheduled actions disposed'))
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    await Promise.allSettled([...this.executions])
    await this.stateTail
  }

  /**
   * Register management tools in one exact mapped WeCom Agent scope.
   *
   * @param toolCtx - Context scoped to the mapped Agent.
   * @param agent - Agent whose Session owns created actions.
   * @param conversationKey - Durable route used for background notifications.
   */
  register(toolCtx: Context, agent: Agent, conversationKey: string): void {
    if (this.definitions.size === 0) return
    const choices = [...this.definitions.values()]
    const description = choices.map(item => `${item.id}: ${item.description}`).join('; ')
    toolCtx.tools.register(defineTool({
      name: 'scheduled_action_create',
      description: 'Schedule one actual allowlisted action for future background execution. Use this instead of '
        + 'executing the action now, reading the clock with another tool, waiting in a shell, or creating a reminder. '
        + `A time-only at value means its next occurrence in ${this.options.config.scheduledActionUtcOffset}. `
        + 'The action is persisted, survives service restart, is rechecked by tool policy at dispatch, and its result '
        + `is actively sent to this WeCom conversation. Available actions: ${description}`,
      parameters: {
        action: { type: 'string', required: true, enum: choices.map(item => item.id) },
        target: { type: 'string', required: true, description: 'Exact target identifier for the selected action.' },
        at: {
          type: 'string',
          required: true,
          description: `Strict RFC 3339 date-time with an explicit offset, or HH:mm[:ss] for the next occurrence in ${this.options.config.scheduledActionUtcOffset}.`,
        },
      },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args, _exec): Promise<JsonValue> => {
        // defineTool validates the deployment-derived enum before execution.
        const definition = this.definitions.get(args.action) as ResolvedAction
        if (!definition.targetPattern.test(args.target)) return error('invalid_target', 'The target is not valid for this action.')
        const now = Date.now()
        const runAt = parseRunAt(args.at, now, this.options.config.scheduledActionUtcOffset)
        if (runAt === undefined) {
          return error('invalid_time', 'at must be a valid RFC 3339 date-time with an explicit offset or HH:mm[:ss].')
        }
        if (runAt <= now) return error('not_future', 'at must be in the future.')
        if (runAt - now > this.options.config.maxScheduledActionDelayMs) {
          return error('time_out_of_range', 'at exceeds the configured scheduling horizon.')
        }
        if (this.controller.signal.aborted) return error('cancelled', 'The scheduling request was cancelled.')
        return this.serialize(async () => {
          const table = this.options.actions.table('actions')
          const owned = [...table.entries()].filter(([, record]) => record.sessionId === agent.session.id)
          if (owned.length >= this.options.config.maxScheduledActionsPerConversation) {
            return error('schedule_limit', 'This conversation has reached its scheduled action limit.')
          }
          const id = randomUUID()
          const record: ScheduledActionRecord = {
            sessionId: agent.session.id,
            conversationKey,
            actionId: definition.id,
            definitionFingerprint: definition.fingerprint,
            target: args.target,
            runAt,
            state: 'pending',
            createdAt: now,
            updatedAt: now,
          }
          await table.put(id, record)
          this.arm(id, runAt)
          return view(id, record)
        })
      },
    }))

    toolCtx.tools.register(defineTool({
      name: 'scheduled_action_list',
      description: 'List pending and currently running background actions owned by this WeCom conversation.',
      parameters: {},
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (_args, _exec): Promise<JsonValue> => {
        return this.serialize(() => Promise.resolve([...this.options.actions.table('actions').entries()]
          .filter(([, record]) => record.sessionId === agent.session.id)
          .sort((left, right) => left[1].createdAt - right[1].createdAt)
          .map(([id, record]) => view(id, record))))
      },
    }))

    toolCtx.tools.register(defineTool({
      name: 'scheduled_action_delete',
      description: 'Cancel one pending background action by its exact scheduled_action_create or scheduled_action_list id. Running actions cannot be cancelled.',
      parameters: { id: { type: 'string', required: true } },
      output: { schema: { type: 'json' }, render: renderJson },
      execute: async (args, _exec): Promise<JsonValue> => {
        return this.serialize(async () => {
          const table = this.options.actions.table('actions')
          const record = table.get(args.id)
          if (record === undefined || record.sessionId !== agent.session.id) return { id: args.id, deleted: false }
          if (record.state === 'running') return error('already_running', 'The scheduled action is already running.')
          await table.delete(args.id)
          const timer = this.timers.get(args.id)
          if (timer !== undefined) clearTimeout(timer)
          this.timers.delete(args.id)
          return { id: args.id, deleted: true }
        })
      },
    }))
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.stateTail.then(operation)
    this.stateTail = result.then(() => {}, () => {})
    return result
  }

  private arm(id: string, runAt: number): void {
    if (this.controller.signal.aborted) return
    const delay = Math.max(0, Math.min(runAt - Date.now(), MAX_TIMER_DELAY_MS))
    const timer = setTimeout(() => {
      this.timers.delete(id)
      if (runAt > Date.now()) {
        this.arm(id, runAt)
        return
      }
      const execution = this.dispatch(id).catch((failure: unknown) => {
        this.ctx.logger.warn(`channel-wecom: scheduled action dispatch failed: ${failure instanceof Error ? failure.message : String(failure)}`)
      })
      this.executions.add(execution)
      void execution.finally(() => { this.executions.delete(execution) })
    }, delay)
    this.timers.set(id, timer)
  }

  private async dispatch(id: string): Promise<void> {
    const record = await this.serialize(async () => {
      const table = this.options.actions.table('actions')
      const current = table.get(id)
      if (current === undefined || current.state !== 'pending') return undefined
      const running = { ...current, state: 'running' as const, updatedAt: Date.now() }
      await table.put(id, running)
      return running
    })
    if (record === undefined || this.isClosed()) return
    const definition = this.definitions.get(record.actionId)
    let result: ToolExecutionResult | undefined
    if (definition !== undefined && definition.fingerprint === record.definitionFingerprint) {
      const timeout = AbortSignal.timeout(this.options.config.scheduledActionTimeoutMs)
      const signal = AbortSignal.any([this.controller.signal, timeout])
      result = await this.ctx.tools.execute({
        callId: ToolCallId(`scheduled-action:${id}`),
        name: definition.toolName,
        arguments: {
          ...definition.arguments,
          [definition.targetArgument]: definition.targetArgumentFormat === 'scalar'
            ? record.target
            : [record.target],
        },
        signal,
      })
    }
    if (this.isClosed()) return
    const conversation = this.options.conversations.table('conversations').get(record.conversationKey)
    if (conversation !== undefined) {
      const prefix = result !== undefined && !result.isError
        ? this.options.config.messages.scheduledActionSuccess
        : this.options.config.messages.scheduledActionFailure
      const detail = result === undefined
        ? this.options.config.messages.scheduledActionDefinitionUnavailable
        : result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      await this.options.enqueueNotification(conversation.target, `${this.notification(prefix, record)}\n\n${detail}`)
    }
    await this.serialize(() => this.options.actions.table('actions').delete(id).then(() => {}))
  }

  private notification(prefix: string, record: ScheduledActionRecord): string {
    return `${prefix}\n\n\`${record.actionId}\` @ \`${record.target}\``
  }

  private isClosed(): boolean {
    return this.controller.signal.aborted
  }
}
