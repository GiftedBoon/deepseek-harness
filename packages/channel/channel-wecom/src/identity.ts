/** Privacy-preserving enterprise WeCom conversation and delivery identities. */

import { createHmac } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { GroupConversationMode, WeComTextDelivery } from './types.ts'

/** Derive one stable opaque key without retaining the provider identifier in the key. */
function opaqueKey(secret: string, namespace: string, value: string): string {
  return createHmac('sha256', secret).update(namespace).update('\0').update(value).digest('base64url')
}

/**
 * Derive the configured conversation identity for one validated delivery.
 * @param source - deployment source namespace.
 * @param secret - stable HMAC identity key.
 * @param mode - configured group ownership.
 * @param delivery - admitted provider message.
 * @returns the opaque conversation key and branded Session id.
 */
export function conversationIdentity(
  source: string,
  secret: string,
  mode: GroupConversationMode,
  delivery: WeComTextDelivery,
): { readonly key: string; readonly sessionId: SessionId } {
  const subject = delivery.chatType === 'single'
    ? `single\0${delivery.userId}`
    : mode === 'shared'
      ? `group\0${delivery.chatId}`
      : `group-user\0${delivery.chatId}\0${delivery.userId}`
  const key = opaqueKey(secret, `channel-wecom:${source}:${delivery.botId}`, subject)
  return { key, sessionId: `wecom-${key}` as SessionId }
}

/**
 * Derive a stable delivery key without storing the provider message id.
 * @param source - deployment source namespace.
 * @param secret - stable HMAC identity key.
 * @param messageId - provider delivery id.
 * @returns the opaque delivery key.
 */
export function deliveryIdentity(source: string, secret: string, messageId: string): string {
  return opaqueKey(secret, `channel-wecom:${source}:delivery`, messageId)
}
