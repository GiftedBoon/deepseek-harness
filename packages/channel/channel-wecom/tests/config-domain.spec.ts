import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { channelWeComDomainSpec } from '../src/domain.ts'

function requiredConfig(): Record<string, unknown> {
  return {
    botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'SESSION', workspacePath: '/workspace',
    agentPreset: 'standard', permissionPreset: 'wecom', allowedUsers: ['user'], allowedChats: [],
    messages: {
      processing: 'processing', timeout: 'timeout', failure: 'failure', emptyReply: 'empty',
      unauthorized: 'unauthorized', duplicate: 'duplicate',
    },
  }
}

describe('WeCom configuration and domain', () => {
  it('materializes deployment defaults and declares durable tables', () => {
    expect(Config(requiredConfig() as never)).toMatchObject({
      groupConversationMode: 'shared', connectTimeoutMs: 15_000, streamFlushIntervalMs: 250,
      maxInputBytes: 32_768, maxReplyBytes: 20_480, turnTimeoutMs: 300_000,
      deliveryRetentionMs: 604_800_000, maxDeliveryRecords: 10_000,
      outboxRetryIntervalMs: 30_000, maxOutboxAttempts: 10,
    })
    expect(channelWeComDomainSpec).toMatchObject({
      name: 'channel_wecom', version: 1,
      tables: { conversations: {}, deliveries: {}, outbox: {} },
    })
  })

  it('rejects absent required values and provider reply limits above the protocol maximum', () => {
    expect(() => Config({ ...requiredConfig(), botId: undefined } as never)).toThrow()
    expect(() => Config({ ...requiredConfig(), maxReplyBytes: 20_481 } as never)).toThrow()
  })
})
