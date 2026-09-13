/** Durable state for allowlisted WeCom scheduled actions. */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Strict durable value for one scheduled action. */
export const scheduledActionRecord = z.object({
  sessionId: z.string().min(1),
  conversationKey: z.string().min(1),
  actionId: z.string().min(1),
  definitionFingerprint: z.string().min(1),
  target: z.string().min(1),
  runAt: z.number().int().nonnegative(),
  state: z.enum(['pending', 'running']),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** One durable action record. */
export type ScheduledActionRecord = z.infer<typeof scheduledActionRecord>

/** Independent versioned state for background action recovery. */
export const weComScheduledActionDomainSpec = defineDomain({
  name: 'channel_wecom_scheduled_action',
  version: 1,
  tables: {
    actions: domainTable(scheduledActionRecord),
  },
})

/** Typed handle for the WeCom scheduled-action domain. */
export type WeComScheduledActionDomain = Domain<typeof weComScheduledActionDomainSpec>
