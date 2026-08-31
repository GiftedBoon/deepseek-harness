/** Runtime admission of untrusted enterprise WeCom text frames. */

import { Buffer } from 'node:buffer'
import type { ResolvedConfig } from './config.ts'
import type { WeComTextDelivery } from './types.ts'

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`WeCom ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`WeCom ${label} must be a non-empty string`)
  return value
}

function allowed(values: readonly string[], candidate: string): boolean {
  return values.includes('*') || values.includes(candidate)
}

/**
 * Validate one SDK callback frame and enforce bot, size, and sender allowlists.
 * @param frame - untrusted SDK callback value.
 * @param config - resolved deployment admission policy.
 * @returns the validated detached text delivery.
 */
export function admitTextFrame(frame: unknown, config: ResolvedConfig): WeComTextDelivery {
  const root = record(frame, 'frame')
  const headers = record(root['headers'], 'frame headers')
  const body = record(root['body'], 'message body')
  const from = record(body['from'], 'message sender')
  const text = record(body['text'], 'text payload')
  const requestId = stringField(headers['req_id'], 'request id')
  const messageId = stringField(body['msgid'], 'message id')
  const botId = stringField(body['aibotid'], 'bot id')
  if (botId !== config.botId) throw new TypeError('WeCom message bot id does not match this channel')
  if (body['msgtype'] !== 'text') throw new TypeError('WeCom channel accepts text messages only')
  const chatType = body['chattype']
  if (chatType !== 'single' && chatType !== 'group') throw new TypeError('WeCom chat type must be single or group')
  const userId = stringField(from['userid'], 'sender user id')
  const content = stringField(text['content'], 'text content')
  if (Buffer.byteLength(content) > config.maxInputBytes) throw new TypeError('WeCom text content exceeds maxInputBytes')
  if (!allowed(config.allowedUsers, userId)) throw new TypeError('WeCom sender is not allowed')
  const chatId = chatType === 'group' ? stringField(body['chatid'], 'group chat id') : undefined
  if (chatId !== undefined && !allowed(config.allowedChats, chatId)) throw new TypeError('WeCom group chat is not allowed')
  return {
    messageId,
    requestId,
    botId,
    chatType,
    userId,
    ...(chatId === undefined ? {} : { chatId }),
    target: chatId ?? userId,
    text: content,
    frame,
  }
}
