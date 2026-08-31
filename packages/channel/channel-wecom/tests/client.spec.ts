import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => {
  class Client {
    readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>()
    readonly replies: unknown[][] = []
    readonly sends: unknown[][] = []
    connected = 0
    disconnected = 0

    constructor(readonly options: { logger: {
      debug: (...args: unknown[]) => void
      info: (...args: unknown[]) => void
      warn: (...args: unknown[]) => void
      error: (...args: unknown[]) => void
    } }) {
      state.instances.push(this)
    }

    on(name: string, listener: (...args: unknown[]) => void): void {
      const listeners = this.listeners.get(name) ?? new Set()
      listeners.add(listener)
      this.listeners.set(name, listeners)
    }

    off(name: string, listener: (...args: unknown[]) => void): void {
      this.listeners.get(name)?.delete(listener)
    }

    emit(name: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(name) ?? []) listener(...args)
    }

    connect(): void { this.connected++ }
    disconnect(): void { this.disconnected++ }
    replyStream(...args: unknown[]): Promise<void> { this.replies.push(args); return Promise.resolve() }
    sendMessage(...args: unknown[]): Promise<void> { this.sends.push(args); return Promise.resolve() }
  }
  const state: { instances: Client[] } = { instances: [] }
  return { Client, state }
})

vi.mock('@wecom/aibot-node-sdk', () => ({
  generateReqId: (prefix: string): string => `${prefix}-request`,
  WSClient: sdk.Client,
}))

import { OfficialWeComClient } from '../src/client.ts'

beforeEach(() => { sdk.state.instances.length = 0 })
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function harness(timeout = 20): { adapter: OfficialWeComClient; client: InstanceType<typeof sdk.Client> } {
  const adapter = new OfficialWeComClient({ botId: 'bot', secret: 'secret', connectTimeoutMs: timeout })
  const client = sdk.state.instances[0]
  if (client === undefined) throw new Error('SDK client was not constructed')
  return { adapter, client }
}

describe('OfficialWeComClient', () => {
  it('silences SDK logs that can contain provider message data', () => {
    const { client } = harness()
    const consoleSpies = [
      vi.spyOn(console, 'debug'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
    ]
    try {
      client.options.logger.debug('private message')
      client.options.logger.info('private message')
      client.options.logger.warn('private message')
      client.options.logger.error('private message')
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('connects until authentication and removes temporary listeners', async () => {
    const { adapter, client } = harness()
    const controller = new AbortController()
    const connected = adapter.connect(controller.signal)
    expect(client.connected).toBe(1)
    client.emit('authenticated')
    await connected
    expect(client.listeners.get('authenticated')).toHaveLength(0)
    expect(client.listeners.get('error')).toHaveLength(0)
  })

  it('rejects SDK errors, abort reasons, default aborts, and timeouts', async () => {
    const sdkFailure = harness()
    const failed = sdkFailure.adapter.connect(new AbortController().signal)
    sdkFailure.client.emit('error', new Error('sdk failed'))
    await expect(failed).rejects.toThrow('sdk failed')

    const explicitAbort = harness()
    const explicitController = new AbortController()
    const explicitlyAborted = explicitAbort.adapter.connect(explicitController.signal)
    explicitController.abort(new Error('stop'))
    await expect(explicitlyAborted).rejects.toThrow('stop')

    const defaultAbort = harness()
    const defaultController = new AbortController()
    defaultController.abort('plain reason')
    await expect(defaultAbort.adapter.connect(defaultController.signal)).rejects.toThrow('WeCom connection aborted')

    vi.useFakeTimers()
    const timed = harness(5)
    const timeout = timed.adapter.connect(new AbortController().signal)
    const timedOut = expect(timeout).rejects.toThrow('WeCom authentication timed out')
    await vi.advanceTimersByTimeAsync(5)
    await timedOut
  })

  it('adapts listeners, ids, replies, sends, and disconnect', async () => {
    const { adapter, client } = harness()
    const texts: unknown[] = []
    const authenticated = vi.fn()
    const offText = adapter.onText((frame) => { texts.push(frame) })
    const offAuthenticated = adapter.onAuthenticated(authenticated)
    const frame = { body: { text: { content: 'hello' } } }
    client.emit('message.text', frame)
    client.emit('authenticated')
    expect(texts).toEqual([frame])
    expect(authenticated).toHaveBeenCalledOnce()
    offText()
    offAuthenticated()
    client.emit('message.text', {})
    client.emit('authenticated')
    expect(texts).toHaveLength(1)
    expect(authenticated).toHaveBeenCalledOnce()

    expect(adapter.createStreamId()).toBe('dsh-request')
    await adapter.replyStream(frame, 'stream', 'answer', true)
    await adapter.sendMarkdown('target', '**answer**')
    expect(client.replies).toEqual([[frame, 'stream', 'answer', true]])
    expect(client.sends).toEqual([['target', { msgtype: 'markdown', markdown: { content: '**answer**' } }]])
    await adapter.disconnect()
    expect(client.disconnected).toBe(1)
  })
})
