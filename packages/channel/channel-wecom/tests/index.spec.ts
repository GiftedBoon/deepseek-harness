import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedConfig } from '../src/config.ts'

const mocks = vi.hoisted(() => {
  class Client {
    constructor(readonly options: unknown) { state.clientOptions.push(options) }
  }
  class Runtime {
    static startError: Error | undefined
    readonly close = vi.fn(() => Promise.resolve())
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
    maxOutboxAttempts: 2,
    messages: {
      processing: 'p', timeout: 't', failure: 'f', emptyReply: 'e', unauthorized: 'u', duplicate: 'd',
    },
    ...overrides,
  }
}

function context(options: { permission?: { approval: string; sandbox: string }; missing?: string } = {}) {
  const calls: string[] = []
  const ctx = {
    permissionPresets: {
      resolve: () => options.permission ?? { approval: 'never', sandbox: 'workspace-write' },
    },
    agentPresets: {
      resolve: async (id: string) => ({ id }),
      standingKeyFor: async () => { calls.push('standing') },
    },
    credentials: {
      resolve: async (reference: { name?: string; key?: string }) => {
        const value = reference.name ?? reference.key ?? String(reference)
        if (options.missing !== undefined && value.includes(options.missing)) return undefined
        return { value: value.includes('SECRET') ? 'bot-secret' : 'identity-secret' }
      },
    },
    workspaceRegistry: { create: async (path: string) => ({ path }) },
    sessionPersistence: { list: async () => [{ id: 'persisted' }] },
    storageDomain: { open: async () => ({ close: async () => {} }) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'model' }) },
    effect: (factory: () => () => Promise<void>) => {
      const cleanup = factory()
      return cleanup
    },
  }
  return { ctx, calls }
}

describe('channel-wecom plugin', () => {
  it('declares its identity and resolves all startup inputs', async () => {
    expect(name).toBe('channel-wecom')
    expect(inject).toContain('storageDomain')
    const test = context()
    await apply(test.ctx as never, config())
    expect(test.calls).toEqual(['standing'])
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
})
