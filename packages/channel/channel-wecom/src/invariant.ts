/** Runtime invariant for enterprise WeCom channel domain changes. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'

const PACKAGE_NAME = '@deepseek-ai/dsh-channel-wecom'

/** Cordis plugin name. */
export const name = 'channel-wecom-invariant'
/** Required diagnostic services. */
export const inject = ['invariants']

/** Ensure every durable delivery and scheduled action references a durable channel conversation. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  ctx.on('domain/changed', (change: DomainChanged) => {
    if (change.domain !== 'channel_wecom'
      && change.domain !== 'channel_wecom_scheduled_action'
      && change.domain !== 'channel_wecom_scheduled_action_input') return
    const domain = ctx.storage.form('domain').get(change.domain)
    if (domain === undefined) {
      return fail(`${change.domain} domain change has no open authoritative domain`)
    }
    if (change.operation !== 'put') return
    if (change.domain === 'channel_wecom' && change.table === 'deliveries') {
      const delivery = change.value as { readonly conversationKey: string }
      if (domain.table('conversations').get(delivery.conversationKey) === undefined) {
        return fail(`channel_wecom delivery '${change.key}' references a missing conversation`)
      }
    }
    if (change.domain === 'channel_wecom_scheduled_action' && change.table === 'actions') {
      const action = change.value as { readonly conversationKey: string }
      const conversations = ctx.storage.form('domain').get('channel_wecom')
      if (conversations?.table('conversations').get(action.conversationKey) === undefined) {
        return fail(`channel_wecom scheduled action '${change.key}' references a missing conversation`)
      }
    }
  }, { global: true })
}, { inject: ['storage'] })

/** Register the package invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
