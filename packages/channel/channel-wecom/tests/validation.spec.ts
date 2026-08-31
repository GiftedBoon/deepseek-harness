import { describe, expect, it } from 'vitest'
import type { ResolvedConfig } from '../src/config.ts'
import { admitTextFrame } from '../src/validation.ts'

const config: ResolvedConfig = {
  botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'KEY', workspacePath: '/tmp',
  agentPreset: 'standard', permissionPreset: 'channel', groupConversationMode: 'shared',
  allowedUsers: ['allowed'], allowedChats: ['chat'], sessionTitlePrefix: 'WeCom',
  connectTimeoutMs: 1, streamFlushIntervalMs: 1, maxInputBytes: 16, maxReplyBytes: 100,
  turnTimeoutMs: 1, deliveryRetentionMs: 1, maxDeliveryRecords: 1,
  outboxRetryIntervalMs: 1, maxOutboxAttempts: 1,
  messages: { processing: 'p', timeout: 't', failure: 'f', emptyReply: 'e', unauthorized: 'u', duplicate: 'd' },
}

function frame(content = 'hello'): unknown {
  return {
    headers: { req_id: 'request' },
    body: {
      msgid: 'message', aibotid: 'bot', chattype: 'group', chatid: 'chat',
      from: { userid: 'allowed' }, msgtype: 'text', text: { content },
    },
  }
}

describe('WeCom frame admission', () => {
  it('returns a detached routing view for an allowed text frame', () => {
    expect(admitTextFrame(frame(), config)).toMatchObject({
      messageId: 'message', requestId: 'request', chatType: 'group',
      userId: 'allowed', chatId: 'chat', target: 'chat', text: 'hello',
    })
  })

  it('rejects bot mismatches, denied senders, and oversized UTF-8 text', () => {
    expect(() => admitTextFrame({ ...(frame() as object), body: { ...(frame() as { body: object }).body, aibotid: 'other' } }, config))
      .toThrow(/bot id/)
    expect(() => admitTextFrame({ ...(frame() as object), body: { ...(frame() as { body: object }).body, from: { userid: 'denied' } } }, config))
      .toThrow(/not allowed/)
    expect(() => admitTextFrame(frame('界'.repeat(6)), config)).toThrow(/maxInputBytes/)
  })
})
