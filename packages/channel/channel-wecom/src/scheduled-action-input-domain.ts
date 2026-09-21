/** Durable model-supplied inputs for parameterized WeCom scheduled actions. */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Strict durable value paired with one scheduled-action id. */
export const scheduledActionInputRecord = z.object({
  value: z.string().min(1),
}).strict()

/** One durable scheduled-action input. */
export type ScheduledActionInputRecord = z.infer<typeof scheduledActionInputRecord>

/** Independent state that leaves the released action-record format unchanged. */
export const weComScheduledActionInputDomainSpec = defineDomain({
  name: 'channel_wecom_scheduled_action_input',
  version: 1,
  tables: {
    inputs: domainTable(scheduledActionInputRecord),
  },
})

/** Typed handle for the WeCom scheduled-action input domain. */
export type WeComScheduledActionInputDomain = Domain<typeof weComScheduledActionInputDomainSpec>
