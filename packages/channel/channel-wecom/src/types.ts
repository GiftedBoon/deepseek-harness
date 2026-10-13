/** Internal enterprise WeCom message and transport values. */


/** Host-generated Markdown notifications using the channel's existing connection and durable outbox. */
export interface WeComNotifications {
  /**
   * Persist a report for the configured exact allowlisted group.
   * @param content - Markdown bounded by the channel's reply byte limit.
   * @returns Resolves after durable queue admission, not provider receipt; rejects on storage failure or disposal.
   */
  enqueue(content: string): Promise<void>
}

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
  /** Upload a PNG as a temporary image and return its provider media id. */
  uploadImage(png: Buffer, filename: string): Promise<string>
  /** Passively reply to an inbound frame with an uploaded image. */
  replyImage(frame: unknown, mediaId: string): Promise<void>
  /** Actively send an uploaded image to a conversation target. */
  sendImage(target: string, mediaId: string): Promise<void>
}
