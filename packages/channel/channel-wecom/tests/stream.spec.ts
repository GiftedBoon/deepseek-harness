import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeComReplyStream, boundUtf8 } from '../src/stream.ts'
import type { WeComChannelClient } from '../src/types.ts'

class FakeClient implements WeComChannelClient {
  readonly replies: Array<{ content: string; finish: boolean }> = []
  connect(): Promise<void> { return Promise.resolve() }
  disconnect(): Promise<void> { return Promise.resolve() }
  onText(): () => void { return () => {} }
  onAuthenticated(): () => void { return () => {} }
  createStreamId(): string { return 'stream' }
  replyStream(_frame: unknown, _id: string, content: string, finish: boolean): Promise<void> {
    this.replies.push({ content, finish })
    return Promise.resolve()
  }
  sendMarkdown(): Promise<void> { return Promise.resolve() }
}

afterEach(() => { vi.useRealTimers() })

describe('WeCom reply stream', () => {
  it('truncates at code-point-safe UTF-8 bounds', () => {
    expect(boundUtf8('甲乙丙', 7)).toBe('甲…')
    expect(Buffer.byteLength(boundUtf8('甲乙丙', 7))).toBeLessThanOrEqual(7)
  })

  it('coalesces cumulative updates and finishes in order', async () => {
    vi.useFakeTimers()
    const client = new FakeClient()
    const stream = new WeComReplyStream({ client, frame: {}, streamId: 'stream', flushIntervalMs: 10, maxReplyBytes: 100 })
    await stream.start('working')
    stream.append('A')
    stream.append('B')
    await vi.advanceTimersByTimeAsync(10)
    await stream.finish('AB')
    expect(client.replies).toEqual([
      { content: 'working', finish: false },
      { content: 'AB', finish: false },
      { content: 'AB', finish: true },
    ])
  })
})
