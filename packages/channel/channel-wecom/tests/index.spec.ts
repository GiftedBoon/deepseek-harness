import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ResolvedConfig } from '../src/config.ts'

const mocks = vi.hoisted(() => {
  class Client {
    constructor(readonly options: unknown) { state.clientOptions.push(options) }
  }
  class Runtime {
    static startError: Error | undefined
    readonly close = vi.fn(() => Promise.resolve())
    readonly enqueueNotification = vi.fn((_content: string) => Promise.resolve())
    constructor(_ctx: unknown, readonly options: unknown) { state.runtimes.push(this) }
    start(): Promise<void> { return Runtime.startError === undefined ? Promise.resolve() : Promise.reject(Runtime.startError) }
  }
  const state: { clientOptions: unknown[]; runtimes: Runtime[] } = { clientOptions: [], runtimes: [] }
  return { Client, Runtime, state }
})

vi.mock('../src/client.ts', () => ({ OfficialWeComClient: mocks.Client }))
vi.mock('../src/runtime.ts', () => ({ WeComChannelRuntime: mocks.Runtime }))

import { apply, inject, name } from '../src/index.ts'

beforeEach(() => {
  mocks.state.clientOptions.length = 0
  mocks.state.runtimes.length = 0
  mocks.Runtime.startError = undefined
})

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'KEY', workspacePath: '/workspace',
    agentPreset: 'standard', permissionPreset: 'wecom', groupConversationMode: 'shared',
    allowedUsers: ['user'], allowedChats: [], sessionTitlePrefix: 'WeCom', connectTimeoutMs: 10,
    streamFlushIntervalMs: 1, maxInputBytes: 100, maxReplyBytes: 100, turnTimeoutMs: 100,
    deliveryRetentionMs: 100, maxDeliveryRecords: 10, outboxRetryIntervalMs: 100,
    maxOutboxAttempts: 2, outboxRetentionMs: 604_800_000,
    scheduledActions: [], maxScheduledActionsPerConversation: 32,
    maxScheduledActionDelayMs: 1_000_000, scheduledActionTimeoutMs: 1_000,
    scheduledActionUtcOffset: '+08:00',
    chartAttachments: undefined,
    messages: {
      processing: 'p', timeout: 't', failure: 'f', emptyReply: 'e', unauthorized: 'u', duplicate: 'd',
      scheduledActionSuccess: 'ss', scheduledActionFailure: 'sf', scheduledActionUncertain: 'su',
      scheduledActionDefinitionUnavailable: 'sd',
    },
    ...overrides,
  }
}

function context(options: {
  permission?: { approval: string; sandbox: string }
  missing?: string
  storageFailureAt?: number
} = {}) {
  const calls: string[] = []
  let opened = 0
  const ctx = {
    permissionPresets: {
      resolve: () => options.permission ?? { approval: 'never', sandbox: 'workspace-write' },
    },
    agentPresets: {
      resolve: async (id: string) => ({ id }),
      acquireScope: async () => {
        calls.push('standing')
        return { [Symbol.asyncDispose]: async () => { calls.push('release-standing') } }
      },
    },
    credentials: {
      resolve: async (value: string) => {
        if (options.missing !== undefined && value.includes(options.missing)) return undefined
        if (value.includes('MCP_KEY')) return { value: 'mcp-secret' }
        return { value: value.includes('SECRET') ? 'bot-secret' : 'identity-secret' }
      },
    },
    workspaceRegistry: { create: async (path: string) => ({ path }) },
    sessionPersistence: {},
    storageDomain: {
      open: async () => {
        opened += 1
        if (opened === options.storageFailureAt) throw new Error('storage open failed')
        const index = opened
        return { close: async () => { calls.push(`close-domain-${String(index)}`) } }
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'model' }) },
    effect: (factory: () => () => Promise<void>) => {
      const cleanup = factory()
      return cleanup
    },
    provide: vi.fn(),
  }
  return { ctx, calls }
}

describe('channel-wecom plugin', () => {
  it('removes the notification service when its owning channel fiber unloads', async () => {
    const ctx = new Context()
    const test = context()
    for (const [service, value] of Object.entries(test.ctx)) {
      if (service !== 'effect' && service !== 'provide') ctx.provide(service, value)
    }
    try {
      const fiber = await ctx.plugin({ apply: (owner: Context) => apply(owner, config({ allowedChats: ['chat'], notificationChatId: 'chat' })) })
      expect(ctx.get('weComNotifications')).toBeDefined()
      await fiber.dispose()
      expect(ctx.get('weComNotifications')).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
  it('publishes the existing connection queue only for a configured exact group', async () => {
    const test = context()
    await apply(test.ctx as never, config({ allowedChats: ['chat'], notificationChatId: 'chat' }))
    expect(test.ctx.provide.mock.calls[0]![0]).toBe('weComNotifications')
    const service = test.ctx.provide.mock.calls[0]![1] as { enqueue: (content: string) => Promise<void> }
    expect(typeof service.enqueue).toBe('function')
    await service.enqueue('report')
    expect(mocks.state.runtimes[0]!.enqueueNotification).toHaveBeenCalledWith('report')
  })

  it('rejects a notification group outside the allowlist before opening storage', async () => {
    const test = context()
    await expect(apply(test.ctx as never, config({ notificationChatId: 'other' }))).rejects.toThrow('exact allowedChats')
    expect(mocks.state.runtimes).toEqual([])
  })
  it('declares its identity and resolves all startup inputs', async () => {
    expect(name).toBe('channel-wecom')
    expect(inject).toContain('storageDomain')
    const test = context()
    await apply(test.ctx as never, config())
    expect(test.calls).toEqual(['standing', 'release-standing'])
    expect(mocks.state.clientOptions[0]).toEqual({ botId: 'bot', secret: 'bot-secret', connectTimeoutMs: 10 })
    expect(mocks.state.runtimes).toHaveLength(1)
  })

  it('rejects relative workspaces and unsafe permission presets', async () => {
    await expect(apply(context().ctx as never, config({ workspacePath: 'relative' }))).rejects.toThrow(/absolute/)
    await expect(apply(context({ permission: { approval: 'ask', sandbox: 'workspace-write' } }).ctx as never, config()))
      .rejects.toThrow(/approval=never/)
    await expect(apply(context({ permission: { approval: 'never', sandbox: 'danger-full-access' } }).ctx as never, config()))
      .rejects.toThrow(/confined sandbox/)
  })

  it('rejects each missing credential', async () => {
    await expect(apply(context({ missing: 'SECRET' }).ctx as never, config())).rejects.toThrow(/SECRET/)
    await expect(apply(context({ missing: 'KEY' }).ctx as never, config())).rejects.toThrow(/KEY/)
  })

  it('disposes the runtime when startup fails', async () => {
    mocks.Runtime.startError = new Error('startup failed')
    await expect(apply(context().ctx as never, config())).rejects.toThrow('startup failed')
    expect(mocks.state.runtimes[0]?.close).toHaveBeenCalledOnce()
  })

  it('closes the channel domain when the scheduled-action domain cannot open', async () => {
    const test = context({ storageFailureAt: 2 })
    await expect(apply(test.ctx as never, config())).rejects.toThrow('storage open failed')
    expect(test.calls).toContain('close-domain-1')
  })

  it('closes both earlier domains when the scheduled-action input domain cannot open', async () => {
    const test = context({ storageFailureAt: 3 })
    await expect(apply(test.ctx as never, config())).rejects.toThrow('storage open failed')
    expect(test.calls).toEqual(expect.arrayContaining(['close-domain-2', 'close-domain-1']))
  })

  it('resolves chart delivery with its credential and passes it to the runtime', async () => {
    const chartAttachments = {
      baseUrl: 'http://charts.test:8095/', apiKeyEnv: 'MCP_KEY', toolNames: ['mcp__x__get_alpha_comparison'],
      maxPerReply: 3, maxBytes: 1_000, fetchTimeoutMs: 500, failureNotice: 'no chart',
    }
    await apply(context().ctx as never, config({ chartAttachments }))
    const options = mocks.state.runtimes[0]?.options as { charts?: { toolNames: Set<string>; maxPerReply: number; failureNotice: string } }
    expect(options.charts?.toolNames).toEqual(new Set(['mcp__x__get_alpha_comparison']))
    expect(options.charts?.maxPerReply).toBe(3)
    expect(options.charts?.failureNotice).toBe('no chart')

    await apply(context().ctx as never, config())
    expect((mocks.state.runtimes[1]?.options as { charts?: unknown }).charts).toBeUndefined()
  })

  it('rejects chart delivery without tools, credential, or an http base', async () => {
    const base = { baseUrl: 'http://charts.test', apiKeyEnv: 'MCP_KEY', toolNames: ['tool'] }
    await expect(apply(context().ctx as never, config({ chartAttachments: { ...base, toolNames: [''] } })))
      .rejects.toThrow(/toolNames/)
    await expect(apply(context({ missing: 'MCP_KEY' }).ctx as never, config({ chartAttachments: base })))
      .rejects.toThrow(/MCP_KEY/)
    await expect(apply(context().ctx as never, config({ chartAttachments: { ...base, baseUrl: 'ftp://charts.test' } })))
      .rejects.toThrow(/http\(s\)/)
  })
})
