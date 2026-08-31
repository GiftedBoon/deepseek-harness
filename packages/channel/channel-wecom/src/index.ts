/** Enterprise WeCom intelligent-bot long-connection channel plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { isAbsolute } from 'node:path'
import { OfficialWeComClient } from './client.ts'
import { Config, type ResolvedConfig } from './config.ts'
import { channelWeComDomainSpec } from './domain.ts'
import { WeComChannelRuntime } from './runtime.ts'

export { Config }
export * from './types.ts'

/** Cordis plugin name. */
export const name = 'channel-wecom'
/** Host capabilities required by the protocol driver. */
export const inject = [
  'agents', 'agentDefaultModel', 'agentPresets', 'credentials', 'permissionPresets',
  'sessionPersistence', 'sessions', 'sessionTitle', 'storageDomain', 'workspaceRegistry',
]

/** Resolve credentials and deployment referents before opening the provider connection. */
export function apply(ctx: Context, config: Config): Promise<void> {
  return (async () => {
    const resolved = config as ResolvedConfig
    if (!isAbsolute(resolved.workspacePath)) throw new Error('channel-wecom: workspacePath must be absolute')
    const permission = ctx.permissionPresets.resolve(resolved.permissionPreset)
    if (permission.approval !== 'never' || permission.sandbox === 'danger-full-access') {
      throw new Error('channel-wecom: permissionPreset must use approval=never and a confined sandbox')
    }
    const preset = await ctx.agentPresets.resolve(resolved.agentPreset)
    await ctx.agentPresets.standingKeyFor(preset.id)
    const secret = await ctx.credentials.resolve(credentialRef(resolved.secretEnv))
    if (secret === undefined) throw new Error(`channel-wecom: credential ${resolved.secretEnv} is not configured`)
    const identity = await ctx.credentials.resolve(credentialRef(resolved.sessionKeyEnv))
    if (identity === undefined) throw new Error(`channel-wecom: credential ${resolved.sessionKeyEnv} is not configured`)
    const workspace = await ctx.workspaceRegistry.create(resolved.workspacePath)
    const persisted = new Set<SessionId>((await ctx.sessionPersistence.list()).map(header => header.id))
    const domain = await ctx.storageDomain.open(channelWeComDomainSpec)
    const runtime = new WeComChannelRuntime(ctx, {
      config: resolved,
      client: new OfficialWeComClient({
        botId: resolved.botId,
        secret: secret.value,
        connectTimeoutMs: resolved.connectTimeoutMs,
      }),
      domain,
      identitySecret: identity.value,
      workspace,
      modelSelection: ctx.agentDefaultModel.currentSelection(),
      persisted,
    })
    const dispose = ctx.effect(() => () => runtime.close(), 'channel-wecom.lifecycle()')
    try {
      await runtime.start()
    } catch (error: unknown) {
      await dispose()
      throw error
    }
  })()
}
