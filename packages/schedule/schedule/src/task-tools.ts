/** Agent-owned executable schedules and bounded durable workflow state. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SELECTOR_PARAMETERS, timingChangeFrom, validateCreateArgs, validateUpdateArgs } from './tools.ts'
import { ScheduleId, ScheduleInputError, scheduleView } from './domain.ts'
import { workflowJsonSchema } from './task-storage.ts'
import type {} from './index.ts'
import type { ScheduleJson, ScheduleExecutionId } from './types.ts'

const OUTPUT = { schema: { type: 'json' }, render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] } as const

/**
 * Register Session-scoped executable task tools.
 * @param root - Schedule owner.
 * @param scoped - Exact Agent tool registry.
 * @param agent - Authority owner.
 * @returns Aggregate disposer.
 */
export function registerTaskTools(root: Context, scoped: Context, agent: Agent): () => void {
  const disposers: Array<() => void> = []
  const guard = async <T>(actual: Agent | undefined, signal: AbortSignal, work: () => Promise<T>): Promise<ScheduleJson> => {
    if (actual !== agent || signal.aborted) return { code: 'internal_error', message: 'The schedule operation failed.' }
    try { return workflowJsonSchema.parse(await work()) } catch (error: unknown) {
      return error instanceof ScheduleInputError ? { code: error.code, message: error.message } : { code: 'internal_error', message: 'The schedule operation failed.' }
    }
  }
  try {
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_task_create',
      description: 'Schedule automatic execution of a user-requested task with this Session\'s tools and permissions. Supply exactly one timing selector. Missed recurring executions coalesce to the latest occurrence. An interrupted execution is recorded and never automatically replayed.',
      parameters: {
        title: { type: 'string', required: true, description: 'Task name, at most 120 characters.' },
        prompt: { type: 'string', required: true, description: 'User-requested instruction to execute.' },
        expires_at: { type: 'string', description: 'Optional offset-bearing RFC 3339 cutoff after the first target. No new execution begins at or after it; running work may finish. Fixed at creation.' },
        after_seconds: { type: 'number', description: 'Positive whole-second delay.' },
        ...SELECTOR_PARAMETERS,
      }, output: OUTPUT,
      execute: (args, exec) => guard(exec.agent, exec.signal, async () => {
        const { expires_at, ...request } = args
        const invalid = validateCreateArgs(request)
        if (invalid !== undefined) return invalid
        const record = await root.schedule.createTask(agent.session.id,
          { ...request, ...(expires_at === undefined ? {} : { expires_at }) }, exec.signal)
        return { ...scheduleView(record, Date.now()), ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) }
      }),
      presentCall: args => ({ card: 'generic', title: 'Schedule task', kind: 'other', rawInput: args }),
    })))
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_task_list', description: 'List active executable tasks in this Session.', parameters: {}, output: OUTPUT,
      execute: (_args, exec) => guard(exec.agent, exec.signal, async () =>
        (await root.schedule.listTasks({ sessionId: agent.session.id })).map(record => ({
          ...scheduleView(record, Date.now()), ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
        }))),
      presentCall: () => ({ card: 'generic', title: 'List tasks', kind: 'read' }),
    })))
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_task_delete', description: 'Delete an executable task in this Session and cancel its unstarted executions. Already running work continues.',
      parameters: { id: { type: 'string', required: true, description: 'Task id returned by schedule_task_create or schedule_task_list.' } }, output: OUTPUT,
      execute: (args, exec) => guard(exec.agent, exec.signal, async () => {
        const own = (await root.schedule.catalog()).find(item => item.id === args.id && item.sessionId === agent.session.id && item.purpose === 'task')
        return own === undefined ? { id: args.id, deleted: false, code: 'schedule_not_found' } : root.schedule.delete({ sessionId: agent.session.id, id: ScheduleId(args.id) }, exec.signal)
      }),
      presentCall: args => ({ card: 'generic', title: 'Delete task', kind: 'other', rawInput: args }),
    })))
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_task_update', description: 'Change an executable task in this Session. Omitted fields keep their values; the execution adapter stays fixed.',
      parameters: { id: { type: 'string', required: true }, title: { type: 'string' }, prompt: { type: 'string' }, ...SELECTOR_PARAMETERS }, output: OUTPUT,
      execute: (args, exec) => guard(exec.agent, exec.signal, async () => {
        const invalid = validateUpdateArgs(args)
        if (invalid !== undefined) return invalid
        const expected = (await root.schedule.listTasks({ sessionId: agent.session.id })).find(record => record.id === args.id)
        if (expected === undefined) return { id: args.id, updated: false, code: 'schedule_not_found' }
        const { expiresAt, ...observed } = expected
        const change = timingChangeFrom(args)
        const result = await root.schedule.update({ sessionId: agent.session.id, id: ScheduleId(args.id), expected: observed,
          ...(change === undefined ? {} : { change }), ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }) }, exec.signal)
        return 'record' in result ? { ...scheduleView(result.record, Date.now()), ...(expiresAt === undefined ? {} : { expiresAt }) } : result
      }),
      presentCall: args => ({ card: 'generic', title: 'Update task', kind: 'other', rawInput: args }),
    })))
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_task_executions', description: 'Read retained queued, running, completed, failed, or interrupted execution results in this Session.',
      parameters: {
        id: { type: 'string', description: 'Optional task id.' },
        limit: { type: 'integer', required: true, description: 'Newest records to return, 1 through 100.' },
        before: { type: 'string', description: 'Optional exclusive cursor: the last execution id from the previous page. Keep the same task filter. A missing or pruned cursor returns invalid_rule.' },
      }, output: OUTPUT,
      execute: (args, exec) => guard(exec.agent, exec.signal, async () => root.schedule.executions({
        sessionId: agent.session.id, limit: args.limit, ...(args.id === undefined ? {} : { id: ScheduleId(args.id) }),
        ...(args.before === undefined ? {} : { before: args.before as ScheduleExecutionId }),
      })),
      presentCall: () => ({ card: 'generic', title: 'Task executions', kind: 'read' }),
    })))
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_state_read', description: 'Read durable workflow state owned by this Session. An absent workflow has revision 0 and value null.',
      parameters: { workflow: { type: 'string', required: true, description: 'Workflow key, 1 through 120 characters.' } }, output: OUTPUT,
      execute: (args, exec) => guard(exec.agent, exec.signal, async () => root.schedule.readState(agent.session.id, args.workflow)),
      presentCall: args => ({ card: 'generic', title: 'Read workflow state', kind: 'read', rawInput: args }),
    })))
    disposers.push(scoped.tools.register(defineTool({
      name: 'schedule_state_write', description: 'Replace durable workflow JSON when expected_revision matches. On state_conflict, read current and recompute. Null clears the value while retaining its revision.',
      parameters: { workflow: { type: 'string', required: true, description: 'Workflow key, 1 through 120 characters.' }, expected_revision: { type: 'integer', required: true, description: 'Revision returned by schedule_state_read or a successful write.' }, value: { type: 'json', required: true, description: 'Complete JSON replacement, bounded by deployment configuration.' } }, output: OUTPUT,
      execute: (args, exec) => guard(exec.agent, exec.signal, async () =>
        root.schedule.writeState(agent.session.id, args.workflow, args.expected_revision, workflowJsonSchema.parse(args.value))),
      presentCall: args => ({ card: 'generic', title: 'Save workflow state', kind: 'other', rawInput: args }),
    })))
  } catch (error: unknown) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let active = true
  return () => { if (!active) return; active = false; for (const dispose of disposers.reverse()) dispose() }
}
