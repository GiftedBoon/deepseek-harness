/** Durable non-session state for enterprise WeCom delivery and retry. */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const conversationRecord = z.object({
  sessionId: z.string().min(1),
  target: z.string().min(1),
  chatType: z.enum(['single', 'group']),
  updatedAt: z.number().int().nonnegative(),
}).strict()

const deliveryRecord = z.object({
  conversationKey: z.string().min(1),
  state: z.enum(['processing', 'completed', 'failed']),
  reply: z.string(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

const outboxRecord = z.object({
  target: z.string().min(1),
  content: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict()

/** Versioned state owned by the enterprise WeCom channel. */
export const channelWeComDomainSpec = defineDomain({
  name: 'channel_wecom',
  version: 1,
  tables: {
    conversations: domainTable(conversationRecord),
    deliveries: domainTable(deliveryRecord),
    outbox: domainTable(outboxRecord),
  },
})

/** Typed handle for the enterprise WeCom channel domain. */
export type ChannelWeComDomain = Domain<typeof channelWeComDomainSpec>
