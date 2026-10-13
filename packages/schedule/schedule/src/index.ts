/** Host-wide durable reminders and shared human/model management. */
import { randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { z as jsonSchema } from 'zod'
import { Context, Service } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity } from '@deepseek-ai/dsh-workspace'
import { ScheduleRuntime } from './runtime.ts'
import { registerScheduleTools } from './tools.ts'
import { ScheduleTaskRuntime } from './task-runtime.ts'
import { hostTaskExecutor } from './task-executor.ts'
import { scheduleExecutionDomain } from './task-storage.ts'
import { registerTaskTools } from './task-tools.ts'
import type { ScheduleTaskExecutor, ScheduleExecution, ScheduleJson, ScheduleWorkflowState, ScheduleTaskCreateRequest, ScheduleTaskRecord } from './types.ts'
import { scheduleDomain } from './storage.ts'
import { deliveryHistoryPage } from './delivery-history.ts'
import { resolveScheduleUpdate } from './update.ts'
import {
  foldScheduleEvents, ScheduleInputError, ScheduleLogError, ScheduleId, createAfterScheduleRecord, createAtScheduleRecord,
  createEveryScheduleRecord, createDailyScheduleRecord, createWeeklyScheduleRecord, createCronScheduleRecord,
  scheduleTitle,
} from './domain.ts'
import type {
  DeliveryRetentionBounds, ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleDeleteRequest, ScheduleDeleteResult,
  ScheduleDeliveryHistoryRequest, ScheduleDeliveryHistoryResult, ScheduleListRequest, ScheduleRecord,
  ScheduleUpdateRequest, ScheduleUpdateResult,
} from './types.ts'

export { renderTaskFraming } from './task-runtime.ts'
export { scheduleExecutionDomain } from './task-storage.ts'
export type * from './types.ts'
export { registerScheduleTools } from './tools.ts'
export { scheduleDomain } from './storage.ts'
export type { ScheduleTask } from './storage.ts'
export type { RecurringOccurrence } from './domain.ts'
export {
  SCHEDULE_CHANGE_VERSION,
  MIN_EVERY_INTERVAL_SECONDS,
  MAX_TITLE_LENGTH,
  ScheduleId,
  ScheduleInputError,
  ScheduleLogError,
  canonicalizeCronExpression,
  createAfterScheduleRecord,
  createAtScheduleRecord,
  createEveryScheduleRecord,
  createDailyScheduleRecord,
  createWeeklyScheduleRecord,
  createCronScheduleRecord,
  decodeScheduleChange,
  decodeScheduleRecord,
  foldScheduleEvents,
  isRecurringScheduleRecord,
  normalizeWeekdays,
  parseCronInput,
  parseWeeklyInput,
  renderReminderFraming,
  renderRecurringReminderBatchFraming,
  resolveEveryOccurrence,
  resolveDailyOccurrence,
  resolveWeeklyOccurrence,
  resolveCronOccurrence,
  resolveRecurringOccurrence,
  scheduleTitle,
  scheduleView,
  weeklyTime,
} from './domain.ts'


declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Durable Host-wide reminder management. */
    schedule: ScheduleService
  }
}

/** Configuration for the Host Schedule domain. */
export interface Config {
  /** Complete workflow record bytes; defaults to 65536. */
  taskStateBytes?: number
  /** Retained workflow keys per Session, including cleared revisions; defaults to 100. */
  taskWorkflowLimit?: number
  /** Complete execution record bytes; defaults to 131072. */
  taskExecutionBytes?: number
  /** Retained settled executions per task; defaults to 200. */
  taskExecutionRecords?: number
  /**
   * Delivery-history window retained per task, in days; omission defaults to 30.
   * Pruning happens when an acknowledgment is appended, and `lastDelivery` is always retained.
   */
  deliveryHistoryDays?: number
  /**
   * Retained delivery records per task; omission defaults to 200. The older of this
   * cap and the window wins, and the newest records survive.
   */
  deliveryHistoryRecords?: number
}

/** Retained delivery-history window applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_DAYS = 30

/** Retained delivery-history record cap applied when the deployment states none. */
const DEFAULT_DELIVERY_HISTORY_RECORDS = 200

/**
 * Shared management service; reads, deletion, and timing edits never activate a Session.
 *
 * `sessionPersistence` is a load-order requirement rather than a directly called
 * service: a delivery commits only when `ctx.sessions.flush()` reports that a
 * `session/flush` listener participated, and the persistence backend providing this
 * service is the plugin that registers that listener.
 */
export class ScheduleService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'tools', 'storageDomain', 'sessionController', 'sessionPersistence']

  static Config: z<Config> = z.object({
    taskStateBytes: z.number().step(1).min(256).max(1048576).default(65536),
    taskWorkflowLimit: z.number().step(1).min(1).max(10000).default(100),
    taskExecutionBytes: z.number().step(1).min(4096).max(1048576).default(131072),
    taskExecutionRecords: z.number().step(1).min(1).max(10000).default(200),
    deliveryHistoryDays: z.number().step(1).min(1).max(3650).default(DEFAULT_DELIVERY_HISTORY_DAYS),
    deliveryHistoryRecords: z.number().step(1).min(1).max(10_000).default(DEFAULT_DELIVERY_HISTORY_RECORDS),
  })

  /** Resolved retention bounds shared with the runtime that appends acknowledgments. */
  private readonly retention: DeliveryRetentionBounds
  private readonly ready: Promise<Domain<typeof scheduleDomain>>
  private readonly taskReady: Promise<Domain<typeof scheduleExecutionDomain>>
  private taskRuntime: ScheduleTaskRuntime | undefined
  private readonly initialized: PromiseLike<unknown>
  private chain: Promise<unknown> = Promise.resolve()
  private runtime: ScheduleRuntime | undefined
  private stopping = false

  /**
   * @param ctx - Host services owning storage, dispatch, and Session restoration.
   * @param config - Validated retention configuration for delivery history.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'schedule')
    this.retention = {
      days: config.deliveryHistoryDays ?? DEFAULT_DELIVERY_HISTORY_DAYS,
      records: config.deliveryHistoryRecords ?? DEFAULT_DELIVERY_HISTORY_RECORDS,
    }
    this.ready = ctx.storageDomain.open(scheduleDomain).then(async (domain) => {
      for (const [key, task] of domain.table('tasks').entries()) {
        if (key !== task.record.id) {
          // The mismatch is the actionable failure; a rejecting close must not replace it.
          try {
            await domain.close()
          } catch (error: unknown) {
            ctx.logger.warn(`schedule: closing the domain after a key mismatch failed: ${String(error)}`)
          }
          throw new Error(`schedule: stored task key "${key}" differs from record id "${task.record.id}"`)
        }
      }
      return domain
    })
    this.taskReady = this.ready.then(async (domain) => {
      let taskDomain: Domain<typeof scheduleExecutionDomain> | undefined
      try {
        taskDomain = await ctx.storageDomain.open(scheduleExecutionDomain)
        const inputs = new Set<import('@deepseek-ai/dsh-llm').MessageId>()
        for (const [id, execution] of taskDomain.table('executions').entries()) {
          if (id !== execution.id) throw new Error('schedule: execution key differs from its stored id')
          if (inputs.has(execution.inputMessageId)) throw new Error('schedule: execution input identity is shared by multiple executions')
          inputs.add(execution.inputMessageId)
          const blockedOwner = taskDomain.table('blocked_inputs').get(execution.inputMessageId)
          if (blockedOwner !== undefined && blockedOwner !== execution.sessionId) throw new Error('schedule: blocked input owner differs from its execution Session')
          const owner = taskDomain.table('owners').get(execution.scheduleId)
          if (owner !== undefined && (owner.sessionId !== execution.sessionId || owner.providerId !== execution.providerId)) throw new Error('schedule: execution owner differs from its task adapter and Session')
        }
        for (const [key, state] of taskDomain.table('states').entries()) {
          if (key !== JSON.stringify([state.sessionId, state.workflow])) throw new Error('schedule: workflow key differs from its stored Session and workflow')
        }
        for (const [id, owner] of taskDomain.table('owners').entries()) {
          const task = domain.table('tasks').get(id)
          if (task !== undefined && task.sessionId !== owner.sessionId) throw new Error('schedule: executable owner differs from its task Session')
        }
        return taskDomain
      } catch (error: unknown) {
        await taskDomain?.close()
        await domain.close()
        throw error
      }
    })
    this.initialized = ctx.effect(async () => {
      const [domain, taskDomain] = await Promise.all([this.ready, this.taskReady])
      let cleanup: () => Promise<void>
      try {
        cleanup = ctx.effect(() => async () => {
          this.stopping = true
          await this.runtime?.dispose()
          await this.taskRuntime?.dispose()
          await this.chain // The chain contains failures after returning them to their callers.
          await domain.close()
          await taskDomain.close()
        })
        this.taskRuntime = new ScheduleTaskRuntime(ctx, taskDomain, work => this.serialize(work), {
          stateBytes: config.taskStateBytes ?? 65536, workflows: config.taskWorkflowLimit ?? 100,
          executionBytes: config.taskExecutionBytes ?? 131072, executionRecords: config.taskExecutionRecords ?? 200,
        })
        await this.taskRuntime.recover()
        this.taskRuntime.register(hostTaskExecutor(ctx))
      } catch (error) {
        this.stopping = true
        await this.taskRuntime?.dispose()
        await domain.close()
        await taskDomain.close()
        throw error
      }
      const tasks = domain.table('tasks')
      this.runtime = new ScheduleRuntime(ctx,
        () => [...tasks.entries()].map(([, task]) => task),
        work => this.serialize(work),
        async (task) => {
          await tasks.put(task.record.id, task)
          this.emitChanged()
        },
        this.retention,
        task => taskDomain.table('owners').get(task.record.id) !== undefined,
        async (task, scheduledAt) => {
          const owner = taskDomain.table('owners').get(task.record.id)
          if (owner === undefined) throw new Error('Executable schedule lacks its persisted owner')
          await this.executionRuntime.admit({
            scheduleId: task.record.id, providerId: owner.providerId, sessionId: task.sessionId,
            title: task.record.title, prompt: task.record.prompt, scheduledAt,
            ...(owner.expiresAt === undefined ? {} : { expiresAt: owner.expiresAt }) })
        },
        (task) => { const expiry = taskDomain.table('owners').get(task.record.id)?.expiresAt; return expiry === undefined ? undefined : Date.parse(expiry) },
        task => this.executionRuntime.cancelQueued(task.record.id, 'expired'))
      this.runtime.requestDrive()
      return cleanup
    })
    const registered = new WeakSet<object>()
    const attached = new Map<import('@deepseek-ai/dsh-agent').Agent, () => Promise<void>>()
    const attach = (agent: import('@deepseek-ai/dsh-agent').Agent): void => {
      if (this.stopping || registered.has(agent) || !ctx.agents.roots().includes(agent)) return
      registered.add(agent)
      // The plugin-scope effect is what tears the Agent-scoped registration down when this
      // plugin unloads, so it must also be disposed when the Agent itself is released.
      attached.set(agent, ctx.effect(
        () => agent.ctx.effect(() => {
          const reminder = registerScheduleTools(ctx, agent.ctx, agent)
          const tasks = registerTaskTools(ctx, agent.ctx, agent)
          return () => { tasks(); reminder() }
        }),
      ))
    }
    ctx.on('agent/created', ({ agent }) => { attach(agent) })
    ctx.on('agent/disposed', ({ agent }) => {
      const detach = attached.get(agent)
      if (detach === undefined) return
      attached.delete(agent)
      // `agent/disposed` declares a void listener, so the disposer promise is not returned;
      // this teardown chain is synchronous, and a failure throws into
      // `AgentRegistry.emitDisposed`, which reports it as a listener throw.
      void detach()
    })
    ctx.on('session/created', (session) => {
      // Historical Schedule events remain readable but do not populate Host tasks.
      // A throwing `session/created` listener rolls the attach back, so an unreadable
      // legacy stream must warn here instead of blocking Session creation.
      let activeLegacy = 0
      try {
        // oxlint-disable-next-line typescript/no-deprecated -- Explicit warning for legacy Schedule history.
        activeLegacy = foldScheduleEvents(session.ownEvents()).active.length
      } catch (error: unknown) {
        /* v8 ignore next -- foldScheduleEvents normalizes every rejected stream to ScheduleLogError. */
        if (!(error instanceof ScheduleLogError)) throw error
        ctx.logger.warn(`schedule: Session "${session.id}" historical events could not be read (${error.message}); the legacy reminder is ignored.`)
        return
      }
      if (activeLegacy > 0) {
        ctx.logger.warn(`schedule: Session "${session.id}" contains legacy reminders; recreate active reminders with schedule_create.`)
      }
    }, { global: true })
    // Host tasks outlive their Session's Agent, so archive admission reads the
    // stored rows rather than a live runtime: an idle Session whose reminders
    // are still armed refuses the archive, and an archiving stop deletes those
    // rows instead of letting them deliver into a closed Session.
    ctx.effect(() => {
      const activity = ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
        const active = [...await this.list({ sessionId }), ...await this.listTasks({ sessionId })]
        const rest = await next()
        if (active.length === 0) return rest
        const own: SessionActivity = {
          kind: 'schedule',
          items: active.map(record => ({ id: record.id, label: record.title })),
        }
        return [own, ...rest]
      })
      const stop = ctx.on('workspace/session-stop', async ({ sessionId }) => {
        await this.stopSessionTasks(sessionId)
      })
      return () => {
        stop()
        activity()
      }
    }, 'schedule.archiveAdmission()')
    for (const agent of ctx.agents.roots()) attach(agent)
  }

  async [Service.init](): Promise<void> {
    await this.initialized
  }

  /**
   * Create a reminder bound to the caller-selected Session without activating it.
   *
   * The request must supply a title; a missing, blank-after-trim, or over-long
   * title rejects with `invalid_prompt` instead of deriving one from the prompt.
   * The record is built from the clock reading taken before the request joins the
   * serialized queue, so a create that waits behind a longer operation keeps its
   * request-time anchor and may already be due when the queue reaches it.
   * @param sessionId - Original Session receiving the reminder.
   * @param request - Validated tool selector, required title, and reminder content.
   * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
   * @returns The durably stored schedule. Cancellation does not roll back an in-flight write.
   */
  async create(sessionId: SessionId, request: ScheduleCreateRequest, signal?: AbortSignal): Promise<ScheduleRecord> {
    return this.createRecord(sessionId, request, signal, false)
  }

  /**
   * Create executable user-requested work with its adapter fixed before arming the timer.
   * @param sessionId - Owner.
   * @param request - Instruction and timing.
   * @param signal - Optional write cancellation.
   * @returns Durable task record.
   */
  async createTask(sessionId: SessionId, request: ScheduleTaskCreateRequest, signal?: AbortSignal): Promise<ScheduleTaskRecord> {
    return this.createRecord(sessionId, request, signal, true)
  }

  private async createRecord(sessionId: SessionId, request: ScheduleTaskCreateRequest,
    signal: AbortSignal | undefined, executable: boolean): Promise<ScheduleTaskRecord> {
    if (Number(request.at !== undefined) + Number(request.after_seconds !== undefined)
      + Number(request.every_seconds !== undefined) + Number(request.daily !== undefined)
      + Number(request.weekly !== undefined) + Number(request.cron !== undefined) > 1) {
      throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    }
    const title = scheduleTitle(request.title)
    const id = ScheduleId(`schedule-${randomUUID()}`)
    const now = Date.now()
    let record: ScheduleRecord
    if (request.at !== undefined) {
      record = createAtScheduleRecord(id, request.prompt, request.at, now, title)
    }
    else if (request.after_seconds !== undefined) {
      record = createAfterScheduleRecord(id, request.prompt, request.after_seconds, now, title)
    }
    else if (request.every_seconds !== undefined) {
      record = createEveryScheduleRecord(id, request.prompt, request.every_seconds, now, title)
    }
    else if (request.daily !== undefined) record = createDailyScheduleRecord(id, request.prompt, request.daily, now, title)
    else if (request.weekly !== undefined) record = createWeeklyScheduleRecord(id, request.prompt, request.weekly, now, title)
    else if (request.cron !== undefined) record = createCronScheduleRecord(id, request.prompt, request.cron, now, title)
    else throw new ScheduleInputError('invalid_selector', 'Exactly one reminder selector is required.')
    let expiresAt: string | undefined
    if (executable && request.expires_at !== undefined) {
      const expiry = jsonSchema.iso.datetime({ offset: true }).safeParse(request.expires_at)
      if (!expiry.success || Date.parse(expiry.data) <= Math.max(now, Date.parse(record.scheduledAt))) throw new ScheduleInputError('invalid_rule', 'expires_at must be an offset-bearing RFC 3339 instant after the first scheduled target.')
      expiresAt = new Date(expiry.data).toISOString()
    }
    return this.serialize(async () => {
      const domain = await this.getDomain()
      signal?.throwIfAborted()
      if (executable) await (await this.taskReady).table('owners').put(id, { sessionId, providerId: this.executionRuntime.providerId(sessionId), ...(expiresAt === undefined ? {} : { expiresAt }) })
      await domain.table('tasks').put(id, {
        sessionId, record, status: 'active', deliveryHistory: { records: [], earlierRecordsUnavailable: false },
      })
      this.emitChanged()
      this.runtime?.requestDrive()
      return { ...record, ...(expiresAt === undefined ? {} : { expiresAt }) }
    })
  }

  /**
   * Read the selected Session's active tasks without resuming its Agent.
   * @param request - Session whose task list is requested.
   * @returns Persisted reminders in storage order.
   */
  @Remote('list')
  async list(request: ScheduleListRequest): Promise<ScheduleRecord[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .filter(([, task]) => task.sessionId === request.sessionId && task.status === 'active' && this.executionRuntime.domain.table('owners').get(task.record.id) === undefined)
      .map(([, task]) => task.record)
  }

  /**
   * Read all active and inactive Host reminders with their original Session bindings.
   * A deleted reminder has no row, so it is absent here.
   * Does not activate Sessions or read Session history.
   * @returns Reminders ordered by scheduledAt ascending, then lexicographically by id.
   */
  @Remote('catalog')
  async catalog(): Promise<ScheduleCatalogEntry[]> {
    const domain = await this.getDomain()
    return [...domain.table('tasks').entries()]
      .map(([, task]) => {
        const owner = this.executionRuntime.domain.table('owners').get(task.record.id)
        return {
          ...task.record, sessionId: task.sessionId, status: task.status,
          ...(owner === undefined ? {} : { purpose: 'task' as const, ...(owner.expiresAt === undefined ? {} : { expiresAt: owner.expiresAt }) }),
          ...(task.lastDelivery === undefined ? {} : { lastDelivery: task.lastDelivery }),
        }
      })
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt) || a.id.localeCompare(b.id))
  }

  /**
   * Read saved inbox deliveries without activating or reading the original Session.
   * The task's own row supplies its binding, so its records stay readable through this lookup.
   * @param request - Session binding, task identity, explicit limit, and optional exclusive message cursor.
   * @returns Newest-first deliveries in append order, or a task/cursor lookup failure.
   * @throws ScheduleInputError when limit is not a safe integer from 1 through 100.
   */
  @Remote('history')
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ScheduleInputError('invalid_rule', 'Delivery history limit must be a safe integer from 1 through 100.')
    }
    const task = (await this.getDomain()).table('tasks').get(request.id)
    if (task === undefined || task.sessionId !== request.sessionId) {
      return { id: request.id, code: 'schedule_not_found' }
    }
    return deliveryHistoryPage(task, request, this.retention)
  }

  /**
   * Delete one task belonging to the selected Session, leaving queued messages intact.
   *
   * The row is removed: the task no longer schedules, leaves `list` and `catalog`, and its
   * saved delivery records go with it.
   * @param request - Session and exact task identity.
   * @param signal - Optional cancellation checked before persistence begins, including after FIFO waits.
   * @returns Whether that Session owned a deleted task. Cancellation does not roll back an in-flight write.
   */
  @Remote('delete')
  async delete(request: ScheduleDeleteRequest, signal?: AbortSignal): Promise<ScheduleDeleteResult> {
    return this.serialize<ScheduleDeleteResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, deleted: false, code: 'schedule_not_found' }
      }
      await this.executionRuntime.cancelQueued(request.id)
      await tasks.delete(request.id)
      await (await this.taskReady).table('owners').delete(request.id)
      this.emitChanged()
      this.runtime?.requestDrive()
      return { id: request.id, deleted: true }
    })
  }

  /**
   * Update the name, instruction, and timing of an active task within the original Session
   * binding without activating the Session or changing saved deliveries.
   *
   * Each supplied field replaces its stored value; an omitted field keeps it. A name or
   * instruction change alone does not reset the committed target.
   * @param request - Task binding, complete observed record, and any combination of timing, name, and instruction.
   * @param signal - Cancellation checked after domain readiness and FIFO waits, before persistence begins.
   * @returns The committed record, unchanged record for a no-op, or a non-mutating input/lookup/conflict result.
   * Storage and lifecycle failures reject; cancellation after a write starts does not roll it back.
   */
  @Remote('update')
  async update(request: ScheduleUpdateRequest, signal?: AbortSignal): Promise<ScheduleUpdateResult> {
    return this.serialize<ScheduleUpdateResult>(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      signal?.throwIfAborted()
      const current = tasks.get(request.id)
      if (current === undefined || current.sessionId !== request.sessionId) {
        return { id: request.id, updated: false, code: 'schedule_not_found' }
      }
      if (current.status === 'inactive') return { id: request.id, updated: false, code: 'schedule_ended' }
      const result = resolveScheduleUpdate(current.record, request.expected, request.change, Date.now(), request)
      if (!('record' in result) || !result.updated) return result
      await tasks.put(request.id, { ...current, record: result.record })
      this.emitChanged()
      this.runtime?.requestDrive()
      return result
    })
  }

  /**
   * Register a named Session executor.
   * @param provider - Adapter retaining preset, permissions, and route.
   * @returns Idempotent disposer.
   */
  registerTaskExecutor(provider: ScheduleTaskExecutor): () => void {
    if (this.taskRuntime === undefined) throw new Error('Schedule service is not initialized')
    return this.taskRuntime.register(provider)
  }

  /**
   * Read executable schedules.
   * @param request - Session owner.
   * @returns Active task records, excluding reminders.
   */
  async listTasks(request: ScheduleListRequest): Promise<ScheduleTaskRecord[]> {
    const domain = await this.getDomain()
    const owners = (await this.taskReady).table('owners')
    return [...domain.table('tasks').entries()].flatMap(([id, task]) => {
      const owner = owners.get(id)
      if (task.sessionId !== request.sessionId || task.status !== 'active' || owner === undefined) return []
      return [{ ...task.record, ...(owner.expiresAt === undefined ? {} : { expiresAt: owner.expiresAt }) }]
    })
  }

  /**
   * Read retained execution facts.
   * @param request - Owner, optional task, page limit, and optional exclusive execution cursor.
   * @returns Newest-first bounded executions; an unknown or pruned cursor rejects with invalid_rule.
   */
  @Remote('executions')
  async executions(request: ScheduleListRequest & {
    id?: import('./types.ts').ScheduleId
    before?: import('./types.ts').ScheduleExecutionId
    limit: number
  }): Promise<ScheduleExecution[]> {
    await this.getDomain()
    if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new ScheduleInputError('invalid_rule', 'Execution limit must be from 1 through 100.')
    const executions = [...(await this.taskReady).table('executions').entries()].map(([, value]) => value)
      .filter(value => value.sessionId === request.sessionId && (request.id === undefined || value.scheduleId === request.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const cursor = request.before === undefined ? -1 : executions.findIndex(value => value.id === request.before)
    if (request.before !== undefined && cursor === -1) throw new ScheduleInputError('invalid_rule', 'Execution cursor is missing or no longer retained for this Session and task.')
    return executions.slice(cursor + 1, cursor + 1 + request.limit)
  }

  /**
   * Read one Session workflow revision.
   * @param sessionId - Owner.
   * @param workflow - Key.
   * @returns Value and revision.
   */
  async readState(sessionId: SessionId, workflow: string): Promise<ScheduleWorkflowState> {
    await this.getDomain()
    return this.executionRuntime.readState(sessionId, workflow)
  }

  /**
   * Replace one workflow with compare-and-set.
   * @param sessionId - Owner.
   * @param workflow - Key.
   * @param revision - Observed revision.
   * @param value - Bounded JSON replacement.
   * @returns Revision or current conflicting state.
   */
  async writeState(sessionId: SessionId, workflow: string, revision: number, value: ScheduleJson): Promise<ScheduleWorkflowState | { code: 'state_conflict'; current: ScheduleWorkflowState }> {
    await this.getDomain()
    return this.executionRuntime.writeState(sessionId, workflow, revision, value)
  }

  /**
   * Dispatch one post-commit `schedule/changed` notification, containing
   * synchronous listener failures: every call site emits only after its durable
   * task write landed, so a throwing listener must not reject the caller or
   * skip the following `requestDrive()`.
   */
  private emitChanged(): void {
    try {
      this.ctx.emit('schedule/changed')
    } catch (error: unknown) {
      // Swallows synchronous observer exceptions only: emit dispatches
      // listeners inline and nothing else runs in the try. The event is a
      // notification, not a transaction participant.
      this.ctx.logger.warn(`schedule: schedule/changed listener failed: ${String(error)}`)
    }
  }

  private async getDomain(): Promise<Domain<typeof scheduleDomain>> {
    await this.initialized
    return this.ready
  }

  /**
   * Remove every active task stored for one Session, inside the queue the tools
   * use.
   *
   * Enumerating and deleting in one queue slot is what makes an archive stop
   * ordered behind a create whose write is still in flight: a stop that read the
   * table outside the queue could miss a row the create was about to commit and
   * leave an armed reminder behind. Re-entering the public `delete()` from here
   * would deadlock on this queue, so the rows are removed directly.
   * @param sessionId - Session whose active Host tasks must stop.
   */
  private async stopSessionTasks(sessionId: SessionId): Promise<void> {
    await this.serialize(async () => {
      const tasks = (await this.getDomain()).table('tasks')
      const active = [...tasks.entries()]
        .filter(([, task]) => task.sessionId === sessionId && task.status === 'active')
        .map(([, task]) => task.record.id)
      if (active.length === 0) return
      // One row per write: the domain table has no batch delete, and each row is
      // durable on its own, so a failure partway through leaves the rows already
      // removed committed. Observers hear about that change before the failure
      // reaches the caller, which still receives it.
      let removed = false
      let failure: Error | undefined
      for (const id of active) {
        try {
          await this.executionRuntime.cancelQueued(id)
          await tasks.delete(id)
          await (await this.taskReady).table('owners').delete(id)
          removed = true
        } catch (error: unknown) {
          // Every row is attempted: the archive has already landed, so a row this
          // stop skipped would stay armed in a Session whose runtime then refuses
          // its model steps. A rejection reason that carries no Error still has to
          // report a failure, so it is wrapped before the first one is kept.
          failure ??= error instanceof Error ? error : new Error(`schedule stop failed: ${String(error)}`)
        }
      }
      if (removed) {
        this.emitChanged()
        this.runtime?.requestDrive()
      }
      if (failure !== undefined) throw failure
    })
  }

  private get executionRuntime(): ScheduleTaskRuntime {
    if (this.taskRuntime === undefined) throw new Error('Schedule service is not initialized')
    return this.taskRuntime
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new Error('Schedule service is stopping'))
    const pending = this.chain.then(work)
    this.chain = pending.catch(() => undefined) // Preserve FIFO progress after the caller receives the failure.
    return pending
  }
}

export default ScheduleService
