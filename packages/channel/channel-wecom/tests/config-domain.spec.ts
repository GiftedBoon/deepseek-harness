import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { channelWeComDomainSpec } from '../src/domain.ts'
import { weComScheduledActionInputDomainSpec } from '../src/scheduled-action-input-domain.ts'
import { weComScheduledActionDomainSpec } from '../src/scheduled-action-domain.ts'

function requiredConfig(): Record<string, unknown> {
  return {
    botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'SESSION', workspacePath: '/workspace',
    agentPreset: 'standard', permissionPreset: 'wecom', allowedUsers: ['user'], allowedChats: [],
    messages: {
      processing: 'processing', timeout: 'timeout', failure: 'failure', emptyReply: 'empty',
      unauthorized: 'unauthorized', duplicate: 'duplicate',
      scheduledActionSuccess: 'success', scheduledActionFailure: 'failure', scheduledActionUncertain: 'uncertain',
      scheduledActionDefinitionUnavailable: 'definition changed',
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
      scheduledActions: [], maxScheduledActionsPerConversation: 32,
      maxScheduledActionDelayMs: 31_536_000_000, scheduledActionTimeoutMs: 300_000,
      scheduledActionUtcOffset: 'Z',
    })
    expect(channelWeComDomainSpec).toMatchObject({
      name: 'channel_wecom', version: 1,
      tables: { conversations: {}, deliveries: {}, outbox: {} },
    })
    expect(weComScheduledActionDomainSpec).toMatchObject({
      name: 'channel_wecom_scheduled_action', version: 1, tables: { actions: {} },
    })
    expect(weComScheduledActionInputDomainSpec).toMatchObject({
      name: 'channel_wecom_scheduled_action_input', version: 1, tables: { inputs: {} },
    })
  })

  it('rejects absent required values and provider reply limits above the protocol maximum', () => {
    expect(() => Config({ ...requiredConfig(), botId: undefined } as never)).toThrow()
    expect(() => Config({ ...requiredConfig(), maxReplyBytes: 20_481 } as never)).toThrow()
    expect(() => Config({ ...requiredConfig(), scheduledActionUtcOffset: '+24:00' } as never)).toThrow()
  })

  it('validates and retains parameterized scheduled-action input configuration', () => {
    const parsed = Config({
      ...requiredConfig(),
      scheduledActions: [{
        id: 'quick_command', description: 'Run a configured command.', toolName: 'quick',
        targetArgument: 'colos', targetArgumentFormat: 'singleton-array',
        targetPattern: '^cf-sh-[12]$', arguments: {},
        input: {
          toolArgument: 'command', description: 'Exact configured key.', maxBytes: 128,
          pattern: '^[A-Za-z0-9_.-]+$',
        },
      }],
    } as never)
    expect(parsed.scheduledActions?.[0]?.input).toEqual({
      toolArgument: 'command', description: 'Exact configured key.', maxBytes: 128,
      pattern: '^[A-Za-z0-9_.-]+$',
    })
    expect(() => Config({
      ...requiredConfig(),
      scheduledActions: [{
        id: 'quick_command', description: 'Run a configured command.', toolName: 'quick',
        targetArgument: 'colos', targetPattern: '^cf-sh-[12]$',
        input: { toolArgument: 'command', description: 'Exact configured key.', maxBytes: 0 },
      }],
    } as never)).toThrow()
  })
})
