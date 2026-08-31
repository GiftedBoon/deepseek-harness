/** Ordered, byte-bounded WeCom streaming reply delivery. */

import { Buffer } from 'node:buffer'
import type { WeComChannelClient } from './types.ts'

/**
 * Truncate UTF-8 text without splitting a code point.
 * @param text - candidate output.
 * @param maxBytes - inclusive UTF-8 byte bound.
 * @param suffix - truncation marker included inside the bound.
 * @returns the original or safely truncated text.
 */
export function boundUtf8(text: string, maxBytes: number, suffix = '…'): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  const suffixBytes = Buffer.byteLength(suffix)
  if (suffixBytes > maxBytes) return ''
  let used = 0
  let result = ''
  for (const character of text) {
    const bytes = Buffer.byteLength(character)
    if (used + bytes + suffixBytes > maxBytes) break
    result += character
    used += bytes
  }
  return result + suffix
}

/** One WeCom stream with coalesced cumulative updates and quiescent close. */
export class WeComReplyStream {
  private content = ''
  private sent = ''
  private timer: ReturnType<typeof setTimeout> | undefined
  private outputTail = Promise.resolve()
  private failure: Error | undefined
  private closed = false

  /** @param options - exact wire frame, stream identity, limits, and transport. */
  constructor(private readonly options: {
    readonly client: WeComChannelClient
    readonly frame: unknown
    readonly streamId: string
    readonly flushIntervalMs: number
    readonly maxReplyBytes: number
  }) {}

  /**
   * Start the provider stream with a visible bounded placeholder.
   * @param placeholder - operator-localized pending text.
   */
  start(placeholder: string): Promise<void> {
    this.content = ''
    return this.enqueue(placeholder, false)
  }

  /**
   * Append visible model output and schedule one cumulative update.
   * @param delta - correlated assistant text delta.
   */
  append(delta: string): void {
    if (this.closed || delta.length === 0) return
    this.content += delta
    if (this.timer !== undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.flush()
    }, this.options.flushIntervalMs)
  }

  /**
   * Send the final complete text and drain every earlier update.
   * @param finalText - complete channel-visible answer.
   */
  finish(finalText: string): Promise<void> {
    if (this.closed) return this.outputTail
    this.closed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.content = finalText
    return this.enqueue(finalText, true)
  }

  /** Stop scheduling output and await already queued writes. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.outputTail
    if (this.failure !== undefined) throw this.failure
  }

  private flush(): void {
    const next = boundUtf8(this.content, this.options.maxReplyBytes)
    if (next === this.sent) return
    void this.enqueue(next, false).catch(() => {})
  }

  private enqueue(content: string, finish: boolean): Promise<void> {
    const next = boundUtf8(content, this.options.maxReplyBytes)
    if (!finish && next === this.sent) return this.outputTail
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const delivery = this.outputTail.then(() => this.options.client.replyStream(
      this.options.frame,
      this.options.streamId,
      next,
      finish,
    ))
    this.outputTail = delivery.then(
      () => { this.sent = next },
      (error: unknown) => {
        this.failure = error instanceof Error ? error : new Error(String(error))
      },
    )
    return delivery
  }
}
