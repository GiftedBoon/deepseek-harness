import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/invariant.ts'

describe('channel-wecom invariant', () => {
  it('registers and accepts delivery changes with an authoritative conversation', async () => {
    let install: ((ctx: unknown, fail: (message: string) => void) => void) | undefined
    const dispose = vi.fn()
    await expect(apply({
      invariants: {
        register: (_packageName: string, candidate: typeof install) => { install = candidate; return dispose },
      },
    } as never)).resolves.toBe(dispose)
    if (install === undefined) throw new Error('invariant was not registered')

    let changed: ((change: Record<string, unknown>) => void) | undefined
    const conversations = new Map([['conversation', {}]])
    install({
      on: (_name: string, listener: typeof changed) => { changed = listener },
      storage: {
        form: () => ({ get: () => ({ table: () => ({ get: (key: string) => conversations.get(key) }) }) }),
      },
    }, vi.fn())
    if (changed === undefined) throw new Error('domain listener was not registered')
    expect(() => changed?.({ domain: 'other' })).not.toThrow()
    expect(() => changed?.({ domain: 'channel_wecom', table: 'outbox', operation: 'put' })).not.toThrow()
    expect(() => changed?.({
      domain: 'channel_wecom', table: 'deliveries', operation: 'put', key: 'delivery',
      value: { conversationKey: 'conversation' },
    })).not.toThrow()
  })

  it('fails when the domain or referenced conversation is missing', async () => {
    let install: ((ctx: unknown, fail: (message: string) => void) => void) | undefined
    await apply({ invariants: { register: (_name: string, candidate: typeof install) => { install = candidate; return () => {} } } } as never)
    if (install === undefined) throw new Error('invariant was not registered')

    let missingDomain: ((change: Record<string, unknown>) => void) | undefined
    install({
      on: (_name: string, listener: typeof missingDomain) => { missingDomain = listener },
      storage: { form: () => ({ get: () => undefined }) },
    }, message => { throw new Error(message) })
    expect(() => missingDomain?.({ domain: 'channel_wecom' })).toThrow(/no open authoritative domain/)

    let missingConversation: ((change: Record<string, unknown>) => void) | undefined
    install({
      on: (_name: string, listener: typeof missingConversation) => { missingConversation = listener },
      storage: { form: () => ({ get: () => ({ table: () => ({ get: () => undefined }) }) }) },
    }, message => { throw new Error(message) })
    expect(() => missingConversation?.({
      domain: 'channel_wecom', table: 'deliveries', operation: 'put', key: 'delivery',
      value: { conversationKey: 'missing' },
    })).toThrow(/references a missing conversation/)
  })
})
