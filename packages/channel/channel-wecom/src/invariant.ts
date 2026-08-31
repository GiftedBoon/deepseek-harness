/** Runtime invariant for enterprise WeCom channel domain changes. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'

const PACKAGE_NAME = '@deepseek-ai/dsh-channel-wecom'

/** Cordis plugin name. */
export const name = 'channel-wecom-invariant'
/** Required diagnostic services. */
export const inject = ['invariants']

/** Ensure every durable delivery references a durable channel conversation. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'channel_wecom') return
    const domain = ctx.storage.form('domain').get('channel_wecom')
    if (domain === undefined) {
      return fail('channel_wecom domain change has no open authoritative domain')
    }
    if (change.table !== 'deliveries' || change.operation !== 'put') return
    const delivery = change.value as { readonly conversationKey: string }
    if (domain.table('conversations').get(delivery.conversationKey) === undefined) {
      return fail(`channel_wecom delivery '${change.key}' references a missing conversation`)
    }
  }, { global: true })
}, { inject: ['storage'] })

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
