/** Snapshot-only projection of production WeCom scheduled-action schemas. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from '../../../packages/channel/channel-wecom/src/config.ts'
import { WeComScheduledActions } from '../../../packages/channel/channel-wecom/src/scheduled-actions.ts'

class MemoryTable {
  private readonly records = new Map<string, unknown>()

  get(key: string): unknown { return this.records.get(key) }
  entries(): IterableIterator<[string, unknown]> { return this.records.entries() }
  put(key: string, value: unknown): Promise<void> { this.records.set(key, value); return Promise.resolve() }
  delete(key: string): Promise<boolean> { return Promise.resolve(this.records.delete(key)) }
}

/** Cordis plugin name. */
export const name = 'wecom-scheduled-action-schema-fixture'
/** Services required to register the production definitions. */
export const inject = ['tools']

/**
 * Register the production management-tool schemas without opening an external WeCom connection.
 *
 * @param ctx - Snapshot composition context.
 * @returns A disposer for the scheduler's background resources.
 */
export function apply(ctx: Context): () => Promise<void> {
  const config = {
    scheduledActionUtcOffset: '+08:00',
    scheduledActions: [{
      id: 'ps_check',
      description: 'Run the bssh_ops allowlisted read-only "ps check" quick command on one colo.',
      toolName: 'mcp__bssh-ops-remote__run_quick_command',
      targetArgument: 'colos',
      targetArgumentFormat: 'singleton-array',
      targetPattern: '^cf-sh-(?:1|2)$',
      arguments: { command: 'check' },
    }],
  } as ResolvedConfig
  const scheduler = new WeComScheduledActions(ctx, {
    config,
    conversations: { table: () => new MemoryTable() } as never,
    actions: { table: () => new MemoryTable() } as never,
    enqueueNotification: () => Promise.resolve(),
  })
  scheduler.register(ctx, { session: { id: 'snapshot-wecom' } } as Agent, 'snapshot-conversation')
  return () => scheduler.close()
}
