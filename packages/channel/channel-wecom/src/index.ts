/** Enterprise WeCom intelligent-bot long-connection channel plugin. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { isAbsolute } from 'node:path'
import { ChartFetcher } from './chart-attachments.ts'
import { OfficialWeComClient } from './client.ts'
import { Config, type ChartAttachmentsConfig, type ResolvedConfig } from './config.ts'
import { channelWeComDomainSpec } from './domain.ts'
import { weComScheduledActionInputDomainSpec } from './scheduled-action-input-domain.ts'
import { weComScheduledActionDomainSpec } from './scheduled-action-domain.ts'
import { WeComChannelRuntime, type ChartDelivery } from './runtime.ts'
import { resolveScheduledActions } from './scheduled-actions.ts'
import type { WeComNotifications } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connected intelligent-bot notification queue for its configured exact group. */
    weComNotifications: WeComNotifications
  }
}

export { Config }
export * from './types.ts'

/** Cordis plugin name. */
export const name = 'channel-wecom'
/** Host capabilities required by the protocol driver. */
export const inject = [
  'agents', 'agentDefaultModel', 'agentPresets', 'credentials', 'permissionPresets',
  'sessionPersistence', 'sessions', 'sessionTitle', 'storageDomain', 'workspaceRegistry',
  'tools',
]

/** Resolve credentials and deployment referents before opening the provider connection. */
export function apply(ctx: Context, config: Config): Promise<void> {
  return (async () => {
    const resolved = config as ResolvedConfig
    resolveScheduledActions(resolved.scheduledActions)
    if (resolved.notificationChatId !== undefined
      && (resolved.notificationChatId === '*' || !resolved.allowedChats.includes(resolved.notificationChatId))) {
      throw new Error('channel-wecom: notificationChatId must name an exact allowedChats entry')
    }
    if (!isAbsolute(resolved.workspacePath)) throw new Error('channel-wecom: workspacePath must be absolute')
    const permission = ctx.permissionPresets.resolve(resolved.permissionPreset)
    if (permission.approval !== 'never' || permission.sandbox === 'danger-full-access') {
      throw new Error('channel-wecom: permissionPreset must use approval=never and a confined sandbox')
    }
    const preset = await ctx.agentPresets.resolve(resolved.agentPreset)
    await using presetScope = await ctx.agentPresets.acquireScope(preset.id)
    void presetScope
    const secret = await ctx.credentials.resolve(credentialRef(resolved.secretEnv))
    if (secret === undefined) throw new Error(`channel-wecom: credential ${resolved.secretEnv} is not configured`)
    const identity = await ctx.credentials.resolve(credentialRef(resolved.sessionKeyEnv))
    if (identity === undefined) throw new Error(`channel-wecom: credential ${resolved.sessionKeyEnv} is not configured`)
    const charts = await resolveChartDelivery(ctx, resolved.chartAttachments)
    const workspace = await ctx.workspaceRegistry.create(resolved.workspacePath)
    const domain = await ctx.storageDomain.open(channelWeComDomainSpec)
    let scheduledActionDomain
    try {
      scheduledActionDomain = await ctx.storageDomain.open(weComScheduledActionDomainSpec)
    } catch (error: unknown) {
      await domain.close()
      throw error
    }
    let scheduledActionInputDomain
    try {
      scheduledActionInputDomain = await ctx.storageDomain.open(weComScheduledActionInputDomainSpec)
    } catch (error: unknown) {
      await scheduledActionDomain.close()
      await domain.close()
      throw error
    }
    const runtime = new WeComChannelRuntime(ctx, {
      config: resolved,
      client: new OfficialWeComClient({
        botId: resolved.botId,
        secret: secret.value,
        connectTimeoutMs: resolved.connectTimeoutMs,
      }),
      domain,
      scheduledActionDomain,
      scheduledActionInputDomain,
      identitySecret: identity.value,
      workspace,
      modelSelection: ctx.agentDefaultModel.currentSelection(),
      ...charts === undefined ? {} : { charts },
    })
    const dispose = ctx.effect(() => () => runtime.close(), 'channel-wecom.lifecycle()')
    try {
      await runtime.start()
      if (resolved.notificationChatId !== undefined) {
        ctx.provide('weComNotifications', { enqueue: content => runtime.enqueueNotification(content) })
      }
    } catch (error: unknown) {
      await dispose()
      throw error
    }
  })()
}

/** Validate chart delivery and resolve its credential before connecting. */
async function resolveChartDelivery(
  ctx: Context,
  config: ChartAttachmentsConfig | undefined,
): Promise<ChartDelivery | undefined> {
  if (config === undefined) return undefined
  const toolNames = new Set(config.toolNames.filter(name => name !== ''))
  if (toolNames.size === 0) throw new Error('channel-wecom: chartAttachments.toolNames must name at least one tool')
  const apiKey = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv))
  if (apiKey === undefined) throw new Error(`channel-wecom: credential ${config.apiKeyEnv} is not configured`)
  return {
    fetcher: new ChartFetcher({
      baseUrl: config.baseUrl,
      apiKey: apiKey.value,
      timeoutMs: config.fetchTimeoutMs ?? 10_000,
      maxBytes: config.maxBytes ?? 4_000_000,
    }),
    toolNames,
    maxPerReply: config.maxPerReply ?? 2,
    failureNotice: config.failureNotice ?? '趋势图发送失败，请稍后重试。',
  }
}
