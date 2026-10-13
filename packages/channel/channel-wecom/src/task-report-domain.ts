/** Durable admission receipts for scheduled Agent reports on the existing WeCom outbox. */

import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Independent report receipts; existing channel storage remains unchanged. */
export const weComTaskReportDomainSpec = defineDomain({
  name: 'channel_wecom_task_reports',
  version: 1,
  tables: {
    reports: domainTable(z.object({
      state: z.enum(['queued', 'delivered', 'expired']),
      sessionId: z.string().min(1).transform(SessionId),
      createdAt: z.number().int().nonnegative(),
    }).strict()),
  },
})

/** Open report-receipt storage owned by one WeCom channel runtime. */
export type WeComTaskReportDomain = Domain<typeof weComTaskReportDomainSpec>
