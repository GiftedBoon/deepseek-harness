/** Internal enterprise WeCom message and transport values. */

/** Supported conversation ownership for group messages. */
export type GroupConversationMode = 'shared' | 'per-user'

/** Validated text message admitted from the WeCom wire. */
export interface WeComTextDelivery {
  readonly messageId: string
  readonly requestId: string
  readonly botId: string
  readonly chatType: 'single' | 'group'
  readonly userId: string
  readonly chatId?: string
  readonly target: string
  readonly text: string
  readonly frame: unknown
}

/** Narrow client interface used by the protocol driver and deterministic tests. */
export interface WeComChannelClient {
  connect(signal: AbortSignal): Promise<void>
  disconnect(): Promise<void>
  onText(listener: (frame: unknown) => void): () => void
  onAuthenticated(listener: () => void): () => void
  createStreamId(): string
  replyStream(frame: unknown, streamId: string, content: string, finish: boolean): Promise<void>
  sendMarkdown(target: string, content: string): Promise<void>
}
