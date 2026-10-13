/** Durable scheduled execution admission; Agent work runs outside management transactions. */
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { scheduleExecutionDomain, executionSchema, workflowJsonSchema } from './task-storage.ts'
import type { ScheduleExecution, ScheduleExecutionId, ScheduleJson, ScheduleTaskExecutor, ScheduleWorkflowState } from './types.ts'
import { ScheduleInputError } from './domain.ts'

/**
 * Explicit execution input, retaining user instruction as user-level text.
 * @param execution - Admitted task.
 * @returns Text for a durable user message.
 */
export function renderTaskFraming(execution: ScheduleExecution): string {
  return `Scheduled task: ${execution.title}\nExecution: ${execution.id}\nScheduled at: ${execution.scheduledAt}\nCurrent time: ${new Date().toISOString()}\nExecute the following user-requested task with the current Session's tools and permissions.\n\n${execution.prompt}`
}

/** Bounds applied to complete stored workflow and execution values. */
export interface TaskBounds {
  stateBytes: number
  workflows: number
  executionBytes: number
  executionRecords: number
}

/** Owns accepted executions, provider registration, and durable state revisions. */
export class ScheduleTaskRuntime {
  private readonly providers = new Set<ScheduleTaskExecutor>()
  private readonly running = new Map<SessionId, { controller: AbortController; done: Promise<void> }>()
  private stopping = false

  /**
   * @param ctx - Event owner.
   * @param domain - Independent durable execution domain.
   * @param transact - Management FIFO.
   * @param bounds - Validated complete-record limits.
   */
  constructor(private readonly ctx: Context, readonly domain: Domain<typeof scheduleExecutionDomain>,
    private readonly transact: <T>(work: () => Promise<T>) => Promise<T>, private readonly bounds: TaskBounds) {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision.kind !== 'enter') return decision
      const known = [...domain.table('executions').entries()].map(([, value]) => value)
      const messages = decision.messages.filter((message) => {
        if (domain.table('blocked_inputs').get(message.id) !== undefined) return false
        const execution = known.find(value => value.inputMessageId === message.id)
        return execution === undefined || execution.sessionId === payload.agent.session.id && execution.status === 'running'
          && (execution.expiresAt === undefined || Date.now() < Date.parse(execution.expiresAt))
      })
      return { ...decision, messages }
    }, { global: true })
  }

  /**
   * Mark uncertain prior runs interrupted; queued work remains unstarted.
   * @returns Resolution after durable recovery.
   */
  async recover(): Promise<void> {
    const executions = [...this.domain.table('executions').entries()].map(([, execution]) => execution)
    for (const execution of executions) {
      if (execution.status === 'failed' || execution.status === 'interrupted') await this.domain.table('blocked_inputs').put(execution.inputMessageId, execution.sessionId)
    }
    for (const execution of executions) {
      if (execution.status === 'running') await this.put(this.failure(execution, 'interrupted', 'Host stopped before execution settlement; inspect effects before retrying.', 'crash'))
    }
  }

  /**
   * Register a Session owner.
   * @param provider - Authority-preserving adapter.
   * @returns Disposer preventing new admissions through this adapter.
   */
  register(provider: ScheduleTaskExecutor): () => void {
    if ([...this.providers].some(value => value.id === provider.id)) throw new Error(`Schedule executor ${provider.id} is already registered`)
    this.providers.add(provider)
    this.requestRun()
    return () => { this.providers.delete(provider) }
  }

  /**
   * Select the executor for a new task.
   * @param sessionId - Original Session.
   * @returns Named specialized owner or the Host adapter.
   */
  providerId(sessionId: SessionId): string {
    const specialized = [...this.providers].filter(provider => provider.id !== 'host' && provider.accepts(sessionId))
    if (specialized.length > 1) throw new Error('Multiple Schedule executors accept this Session')
    return specialized[0]?.id ?? 'host'
  }

  /**
   * Admit at most one queued occurrence per task, coalescing newer due work.
   * @param input - Occurrence selected by the Host timer.
   * @returns Resolution after admission.
   */
  async admit(input: Omit<ScheduleExecution, 'id' | 'status' | 'createdAt' | 'inputMessageId'>): Promise<void> {
    const executions = this.domain.table('executions')
    const own = [...executions.entries()].map(([, value]) => value).filter(value => value.scheduleId === input.scheduleId)
    if (own.some(value => value.scheduledAt === input.scheduledAt)) { this.requestRun(); return }
    const queued = own.find(value => value.status === 'queued')
    const execution: ScheduleExecution = {
      ...input, id: queued?.id ?? `execution-${randomUUID()}` as ScheduleExecutionId,
      inputMessageId: queued?.inputMessageId ?? MessageId(randomUUID()),
      createdAt: new Date().toISOString(), status: 'queued',
    }
    await this.put(execution)
    await this.prune(input.scheduleId)
    this.requestRun()
  }

  /**
   * Read a Session-owned workflow revision.
   * @param sessionId - State owner.
   * @param workflow - Validated key.
   * @returns Detached current value and revision, or absent revision zero.
   */
  readState(sessionId: SessionId, workflow: string): ScheduleWorkflowState {
    this.validateWorkflow(workflow)
    const state = this.domain.table('states').get(JSON.stringify([sessionId, workflow]))
    return state === undefined ? { workflow, revision: 0, value: null }
      : { workflow, revision: state.revision, value: structuredClone(state.value) }
  }

  /**
   * Compare and set one bounded state value.
   * @param sessionId - Owner.
   * @param workflow - Key.
   * @param revision - Observed revision.
   * @param value - Complete JSON replacement.
   * @returns Committed revision or conflict with current value.
   */
  async writeState(sessionId: SessionId, workflow: string, revision: number, value: ScheduleJson): Promise<ScheduleWorkflowState | { code: 'state_conflict'; current: ScheduleWorkflowState }> {
    return this.transact(async () => {
      const current = this.readState(sessionId, workflow)
      if (!Number.isSafeInteger(revision) || revision < 0) throw new ScheduleInputError('invalid_rule', 'expected_revision must be a non-negative safe integer.')
      if (current.revision !== revision) return { code: 'state_conflict', current }
      if (revision === Number.MAX_SAFE_INTEGER) throw new ScheduleInputError('invalid_rule', 'Workflow revision is exhausted.')
      const next = { sessionId, workflow, revision: revision + 1, value: workflowJsonSchema.parse(value) }
      if (Buffer.byteLength(JSON.stringify(next)) > this.bounds.stateBytes) throw new ScheduleInputError('invalid_rule', 'Workflow state exceeds the configured byte limit.')
      if (revision === 0 && [...this.domain.table('states').entries()].filter(([, state]) => state.sessionId === sessionId).length >= this.bounds.workflows) throw new ScheduleInputError('invalid_rule', 'Session workflow count exceeds the configured limit.')
      await this.domain.table('states').put(JSON.stringify([sessionId, workflow]), next)
      return { workflow, revision: next.revision, value: structuredClone(next.value) }
    })
  }

  /**
   * Suppress unstarted work after task deletion.
   * @param scheduleId - Deleted task.
   * @param reason - Unstarted cancellation or expiry, distinguished from uncertain running work.
   * @returns Resolution after durable cancellation.
   */
  async cancelQueued(scheduleId: ScheduleExecution['scheduleId'], reason: 'cancelled' | 'expired' = 'cancelled'): Promise<void> {
    for (const [, value] of this.domain.table('executions').entries()) {
      if (value.scheduleId === scheduleId && value.status === 'queued') await this.put(this.failure(value, 'interrupted', reason === 'expired' ? 'Task expired before execution began.' : 'Task deleted before execution began.', reason))
    }
  }

  /**
   * Stop admission, cancel owned provider work, and await settlement before storage closes.
   * @returns Quiescent completion.
   */
  async dispose(): Promise<void> {
    this.stopping = true
    for (const { controller } of this.running.values()) controller.abort()
    await Promise.all([...this.running.values()].map(({ done }) => done))
  }

  private validateWorkflow(workflow: string): void {
    if (workflow.length === 0 || workflow.length > 120 || workflow.trim() !== workflow) throw new ScheduleInputError('invalid_rule', 'workflow must contain 1 through 120 characters without surrounding whitespace.')
  }

  private async put(execution: ScheduleExecution): Promise<void> {
    const parsed = executionSchema.parse(execution)
    const bounded = parsed.status === 'queued' || parsed.status === 'running'
      ? { ...parsed, status: 'interrupted', interruptionReason: 'cancelled' } : parsed
    if (Buffer.byteLength(JSON.stringify(bounded)) > this.bounds.executionBytes) throw new Error('Scheduled execution exceeds the configured byte limit')
    if (parsed.status === 'failed' || parsed.status === 'interrupted') await this.domain.table('blocked_inputs').put(parsed.inputMessageId, parsed.sessionId)
    await this.domain.table('executions').put(execution.id, parsed)
    if (parsed.status !== 'queued' && parsed.status !== 'running') await this.prune(parsed.scheduleId)
    try { this.ctx.emit('schedule/execution', parsed) } catch (error: unknown) { this.ctx.logger.warn(`schedule: execution listener failed: ${String(error)}`) }
    try { this.ctx.emit('schedule/changed') } catch (error: unknown) { this.ctx.logger.warn(`schedule: catalog listener failed: ${String(error)}`) }
  }

  private async prune(scheduleId: ScheduleExecution['scheduleId']): Promise<void> {
    const settled = [...this.domain.table('executions').entries()].map(([, value]) => value)
      .filter(value => value.scheduleId === scheduleId && value.status !== 'queued' && value.status !== 'running')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    for (const value of settled.slice(this.bounds.executionRecords)) await this.domain.table('executions').delete(value.id)
  }

  private requestRun(): void {
    if (this.stopping) return
    for (const [, candidate] of this.domain.table('executions').entries()) {
      if (candidate.status !== 'queued' || this.running.has(candidate.sessionId)) continue
      const providers = [...this.providers].filter(provider =>
        provider.id === candidate.providerId && provider.accepts(candidate.sessionId))
      if (providers.length !== 1) continue
      const provider = providers[0]
      if (provider === undefined) continue
      const controller = new AbortController()
      const done = this.run(candidate, provider, controller.signal).catch((error: unknown) => {
        this.ctx.logger.warn(`schedule: execution settlement failed: ${String(error)}`)
      }).finally(() => {
        this.running.delete(candidate.sessionId)
        this.requestRun()
      })
      this.running.set(candidate.sessionId, { controller, done })
    }
  }

  private async run(candidate: ScheduleExecution, provider: ScheduleTaskExecutor, signal: AbortSignal): Promise<void> {
    const claimed = await this.transact(async () => {
      const current = this.domain.table('executions').get(candidate.id)
      if (current?.status !== 'queued' || signal.aborted) return undefined
      if (current.expiresAt !== undefined && Date.now() >= Date.parse(current.expiresAt)) {
        await this.put(this.failure(current, 'interrupted', 'Task expired before execution began.', 'expired'))
        return undefined
      }
      const execution: ScheduleExecution = { ...current, status: 'running' }
      await this.put(execution)
      return execution
    })
    if (claimed === undefined) return
    let settled: ScheduleExecution
    try {
      const outcome = await provider.execute(claimed, signal)
      if (outcome.inputMessageId !== undefined && outcome.inputMessageId !== claimed.inputMessageId) throw new Error('Scheduled input identity differs from durable admission')
      settled = executionSchema.parse({ ...claimed, ...outcome })
      if (Buffer.byteLength(JSON.stringify(settled)) > this.bounds.executionBytes) throw new Error('Scheduled result exceeds the configured byte limit')
    } catch (error: unknown) {
      settled = this.failure(claimed, signal.aborted ? 'interrupted' : 'failed', String(error), signal.aborted ? 'unloaded' : undefined)
    }
    // Teardown still permits already-admitted settlements; the domain remains open until dispose drains them.
    await this.put(settled)
  }

  private failure(execution: ScheduleExecution, status: 'failed' | 'interrupted', error: string, reason?: ScheduleExecution['interruptionReason']): ScheduleExecution {
    const base = { ...execution, status, ...(reason === undefined ? {} : { interruptionReason: reason }) }
    // Error diagnostics consume only space remaining after the complete admitted record.
    let low = 0
    let high = error.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify({ ...base, error: error.slice(0, middle) })) <= this.bounds.executionBytes) low = middle
      else high = middle - 1
    }
    return low === 0 ? base : { ...base, error: error.slice(0, low) }
  }
}
