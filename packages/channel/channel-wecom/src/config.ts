/** Deployment configuration for the enterprise WeCom long-connection channel. */

import z from '@deepseek-ai/schemastery'
import type { GroupConversationMode } from './types.ts'

/** Operator-owned user-visible channel messages. */
export interface ChannelMessages {
  /** Placeholder sent before the first model delta. */
  processing: string
  /** Final text after the Agent turn exceeds its deadline. */
  timeout: string
  /** Final text after another processing failure. */
  failure: string
  /** Final text when a successful turn emitted no visible text. */
  emptyReply: string
  /** Reply for a frame that fails admission. */
  unauthorized: string
  /** Reply while the same delivery id is already processing. */
  duplicate: string
  /** Prefix for a completed scheduled action notification. */
  scheduledActionSuccess: string
  /** Prefix for a failed scheduled action notification. */
  scheduledActionFailure: string
  /** Prefix for a scheduled action whose side-effect outcome is unknown after recovery. */
  scheduledActionUncertain: string
  /** Detail for a scheduled action whose configured definition is absent or changed at dispatch. */
  scheduledActionDefinitionUnavailable: string
}

/** Deployment-owned allowlisted action available to the WeCom scheduling tools. */
export interface ScheduledActionConfig {
  /** Stable model-facing action identifier. */
  id: string
  /** Short model-facing description of the allowlisted operation. */
  description: string
  /** Exact registered tool name dispatched when the action becomes due. */
  toolName: string
  /** Top-level tool argument receiving the model-supplied target. */
  targetArgument: string
  /** Encoding used when placing the target into the configured tool argument. */
  targetArgumentFormat?: 'scalar' | 'singleton-array'
  /** Anchored regular expression admitting target identifiers for this action. */
  targetPattern: string
  /** Static lossless-JSON arguments merged with the target argument. */
  arguments?: unknown
}

/** Enterprise WeCom channel configuration. */
export interface Config {
  /** Enterprise WeCom intelligent-bot id. */
  botId: string
  /** Credential reference containing the bot secret. */
  secretEnv: string
  /** Credential reference containing the stable HMAC identity key. */
  sessionKeyEnv: string
  /** Existing absolute directory owned by every mapped Session. */
  workspacePath: string
  /** Agent preset mounted for each delivery activation. */
  agentPreset: string
  /** Confined, noninteractive permission preset applied to mapped Sessions. */
  permissionPreset: string
  /** Whether a group owns one Session or one Session per sender. */
  groupConversationMode?: GroupConversationMode
  /** Exact admitted sender ids, with `*` as an explicit wildcard. */
  allowedUsers: string[]
  /** Exact admitted group ids, with `*` as an explicit wildcard. */
  allowedChats: string[]
  /** Prefix used for newly created Session titles. */
  sessionTitlePrefix?: string
  /** Maximum wait for the first successful SDK authentication. */
  connectTimeoutMs?: number
  /** Minimum delay used to coalesce cumulative stream updates. */
  streamFlushIntervalMs?: number
  /** Maximum inbound text length measured as UTF-8 bytes. */
  maxInputBytes?: number
  /** Maximum outbound text length measured as UTF-8 bytes. */
  maxReplyBytes?: number
  /** Maximum wait for the correlated Agent turn to end. */
  turnTimeoutMs?: number
  /** Age after which delivery deduplication records are removed. */
  deliveryRetentionMs?: number
  /** Maximum retained delivery deduplication records. */
  maxDeliveryRecords?: number
  /** Interval between active-send outbox retry passes. */
  outboxRetryIntervalMs?: number
  /** Failed active sends allowed before an outbox item is dropped. */
  maxOutboxAttempts?: number
  /** Deployment allowlist for durable, future tool execution. */
  scheduledActions?: ScheduledActionConfig[]
  /** Maximum pending or running actions retained for one conversation. */
  maxScheduledActionsPerConversation?: number
  /** Furthest permitted future execution time from creation. */
  maxScheduledActionDelayMs?: number
  /** Cooperative deadline supplied to one background tool execution. */
  scheduledActionTimeoutMs?: number
  /** Fixed numeric offset used to resolve time-only scheduled-action requests. */
  scheduledActionUtcOffset?: string
  /** Operator-localized text sent by channel-owned states. */
  messages: ChannelMessages
}

/** Schemastery validation for deployment-controlled WeCom options. */
export const Config: z<Config> = z.object({
  botId: z.string().required(),
  secretEnv: z.string().required(),
  sessionKeyEnv: z.string().required(),
  workspacePath: z.string().required(),
  agentPreset: z.string().required(),
  permissionPreset: z.string().required(),
  groupConversationMode: z.union(['shared', 'per-user']).default('shared'),
  allowedUsers: z.array(z.string()).required(),
  allowedChats: z.array(z.string()).required(),
  sessionTitlePrefix: z.string().default('WeCom'),
  connectTimeoutMs: z.number().min(1).default(15_000),
  streamFlushIntervalMs: z.number().min(1).default(250),
  maxInputBytes: z.number().min(1).default(32_768),
  maxReplyBytes: z.number().min(1).max(20_480).default(20_480),
  turnTimeoutMs: z.number().min(1).default(300_000),
  deliveryRetentionMs: z.number().min(1).default(604_800_000),
  maxDeliveryRecords: z.number().min(1).default(10_000),
  outboxRetryIntervalMs: z.number().min(1).default(30_000),
  maxOutboxAttempts: z.number().min(1).default(10),
  scheduledActions: z.array(z.object({
    id: z.string().required(),
    description: z.string().required(),
    toolName: z.string().required(),
    targetArgument: z.string().required(),
    targetArgumentFormat: z.union(['scalar', 'singleton-array']).default('scalar'),
    targetPattern: z.string().required(),
    arguments: z.any().default({}),
  })).default([]),
  maxScheduledActionsPerConversation: z.number().min(1).default(32),
  maxScheduledActionDelayMs: z.number().min(1).default(31_536_000_000),
  scheduledActionTimeoutMs: z.number().min(1).default(300_000),
  scheduledActionUtcOffset: z.string().pattern(/^(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/).default('Z'),
  messages: z.object({
    processing: z.string().required(),
    timeout: z.string().required(),
    failure: z.string().required(),
    emptyReply: z.string().required(),
    unauthorized: z.string().required(),
    duplicate: z.string().required(),
    scheduledActionSuccess: z.string().required(),
    scheduledActionFailure: z.string().required(),
    scheduledActionUncertain: z.string().required(),
    scheduledActionDefinitionUnavailable: z.string().required(),
  }).required(),
})

/** Config after Schemastery defaults have been applied. */
export type ResolvedConfig = Required<Config>
