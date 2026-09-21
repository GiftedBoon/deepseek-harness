/** Official WeCom SDK adapter behind the channel's narrow transport interface. */

import { WSClient, generateReqId, type Logger, type TextMessage, type WsFrame, type WsFrameHeaders } from '@wecom/aibot-node-sdk'
import type { WeComChannelClient } from './types.ts'

const silentSdkLogger: Logger = Object.freeze({
  debug: (): void => {},
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
})

/**
 * Render a rejected SDK reply as an Error that keeps the provider diagnostic.
 *
 * The SDK rejects with the acknowledgement frame, whose `errcode` and `errmsg`
 * are the only statement of why the provider refused the send.
 * @param error - the value the SDK rejected with.
 * @returns an Error whose message names the provider error code.
 */
function replyFailure(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'object' && error !== null) {
    const frame = error as { readonly errcode?: unknown; readonly errmsg?: unknown }
    const parts: string[] = []
    if (typeof frame.errcode === 'number') parts.push(`errcode=${frame.errcode}`)
    if (typeof frame.errmsg === 'string') parts.push(`errmsg=${frame.errmsg}`)
    if (parts.length > 0) return new Error(`WeCom reply rejected: ${parts.join(' ')}`, { cause: error })
  }
  return new Error(`WeCom reply rejected: ${String(error)}`, { cause: error })
}

/** Adapt the maintained official SDK and await the first successful authentication. */
export class OfficialWeComClient implements WeComChannelClient {
  private readonly client: WSClient

  /** @param options - bot credentials and initial authentication timeout. */
  constructor(private readonly options: { botId: string; secret: string; connectTimeoutMs: number }) {
    this.client = new WSClient({ botId: options.botId, secret: options.secret, logger: silentSdkLogger })
  }

  /** Connect and resolve after authentication, rejecting abort, timeout, or SDK error. */
  connect(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish(new Error('WeCom authentication timed out')) }, this.options.connectTimeoutMs)
      const authenticated = (): void => { finish() }
      const failed = (error: Error): void => { finish(error) }
      const aborted = (): void => { finish(signal.reason instanceof Error ? signal.reason : new Error('WeCom connection aborted')) }
      const finish = (error?: Error): void => {
        clearTimeout(timer)
        this.client.off('authenticated', authenticated)
        this.client.off('error', failed)
        signal.removeEventListener('abort', aborted)
        if (error === undefined) resolve()
        else reject(error)
      }
      this.client.on('authenticated', authenticated)
      this.client.on('error', failed)
      signal.addEventListener('abort', aborted, { once: true })
      if (signal.aborted) aborted()
      else this.client.connect()
    })
  }

  /** Disconnect the SDK transport. */
  disconnect(): Promise<void> {
    this.client.disconnect()
    return Promise.resolve()
  }

  /** Register a text-message listener. */
  onText(listener: (frame: unknown) => void): () => void {
    const typed = (frame: WsFrame<TextMessage>): void => { listener(frame) }
    this.client.on('message.text', typed)
    return () => { this.client.off('message.text', typed) }
  }

  /** Register an authentication listener, including reconnect authentication. */
  onAuthenticated(listener: () => void): () => void {
    this.client.on('authenticated', listener)
    return () => { this.client.off('authenticated', listener) }
  }

  /** Create an SDK-compatible opaque stream id. */
  createStreamId(): string {
    return generateReqId('dsh')
  }

  /** Send one cumulative passive stream update. */
  async replyStream(frame: unknown, streamId: string, content: string, finish: boolean): Promise<void> {
    try {
      await this.client.replyStream(frame as WsFrameHeaders, streamId, content, finish)
    } catch (error: unknown) {
      throw replyFailure(error)
    }
  }

  /** Send an active Markdown fallback or retry. */
  async sendMarkdown(target: string, content: string): Promise<void> {
    try {
      await this.client.sendMessage(target, { msgtype: 'markdown', markdown: { content } })
    } catch (error: unknown) {
      throw replyFailure(error)
    }
  }
}
