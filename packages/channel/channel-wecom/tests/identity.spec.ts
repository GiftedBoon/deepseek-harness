import { describe, expect, it } from 'vitest'
import { conversationIdentity, deliveryIdentity } from '../src/identity.ts'
import type { WeComTextDelivery } from '../src/types.ts'

function delivery(overrides: Partial<WeComTextDelivery> = {}): WeComTextDelivery {
  return {
    messageId: 'message-raw',
    requestId: 'request-raw',
    botId: 'bot-raw',
    chatType: 'group',
    userId: 'user-raw',
    chatId: 'chat-raw',
    target: 'chat-raw',
    text: 'hello',
    frame: {},
    ...overrides,
  }
}

describe('WeCom opaque identities', () => {
  it('is stable without retaining provider identifiers', () => {
    const first = conversationIdentity('source', 'secret', 'shared', delivery())
    const second = conversationIdentity('source', 'secret', 'shared', delivery())
    expect(first).toEqual(second)
    expect(first.sessionId).toMatch(/^wecom-/)
    expect(first.key).not.toContain('chat-raw')
    expect(deliveryIdentity('source', 'secret', 'message-raw')).not.toContain('message-raw')
  })

  it('shares group sessions only in shared mode', () => {
    const other = delivery({ userId: 'other-user' })
    expect(conversationIdentity('source', 'secret', 'shared', delivery()))
      .toEqual(conversationIdentity('source', 'secret', 'shared', other))
    expect(conversationIdentity('source', 'secret', 'per-user', delivery()))
      .not.toEqual(conversationIdentity('source', 'secret', 'per-user', other))
  })
})
