/** Execution and workflow storage does not alter released reminder records or Session events. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ScheduleJson, ScheduleExecutionId } from './types.ts'
import { ScheduleId } from './domain.ts'

/** Decode lossless JSON at the durable and model boundaries. */
export const workflowJsonSchema: z.ZodType<ScheduleJson> = z.lazy(() => z.union([
  z.null(), z.boolean(), z.number(), z.string(), z.array(workflowJsonSchema), z.record(z.string(), workflowJsonSchema),
]))

/** Strict persisted execution, validated before insertion and at cold open. */
export const executionSchema = z.object({
  id: z.string().min(1).transform(value => value as ScheduleExecutionId),
  providerId: z.string().min(1),
  scheduleId: z.string().min(1).transform(ScheduleId),
  sessionId: z.string().min(1).transform(SessionId),
  title: z.string().min(1), prompt: z.string().min(1),
  scheduledAt: z.iso.datetime({ precision: 3 }), createdAt: z.iso.datetime({ precision: 3 }),
  expiresAt: z.iso.datetime({ precision: 3 }).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'interrupted']),
  interruptionReason: z.enum(['cancelled', 'expired', 'unloaded', 'crash']).optional(),
  inputMessageId: z.string().min(1).transform(MessageId),
  messageIds: z.array(z.string().min(1).transform(MessageId)).optional(),
  output: z.string().optional(), error: z.string().optional(),
}).strict()

/** Execution history may be pruned; blocked input identities remain for the Session lifetime. */
export const scheduleExecutionDomain = defineDomain({
  name: 'schedule_execution', version: 1,
  tables: {
    blocked_inputs: domainTable<MessageId, SessionId>(z.string().min(1).transform(SessionId)),
    owners: domainTable<import('./types.ts').ScheduleId, {
      sessionId: import('@deepseek-ai/dsh-session').SessionId
      providerId: string
      expiresAt?: string | undefined
    }>(
      z.object({ sessionId: z.string().min(1).transform(SessionId), providerId: z.string().min(1),
        expiresAt: z.iso.datetime({ precision: 3 }).optional() }).strict()),
    executions: domainTable<ScheduleExecutionId, z.infer<typeof executionSchema>>(executionSchema),
    states: domainTable<string, { sessionId: import('@deepseek-ai/dsh-session').SessionId; workflow: string; revision: number; value: ScheduleJson }>(
      z.object({ sessionId: z.string().min(1).transform(SessionId),
        workflow: z.string().min(1).max(120).refine(value => value.trim() === value),
        revision: z.number().int().positive(), value: workflowJsonSchema }).strict()),
  },
})
