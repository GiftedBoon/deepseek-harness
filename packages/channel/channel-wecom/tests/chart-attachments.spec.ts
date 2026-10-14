import { describe, expect, it, vi } from 'vitest'
import { ChartFetcher, extractChartIds, mergeChartIds } from '../src/chart-attachments.ts'

const ID = '0123456789abcdef0123456789abcdef'
const OTHER = 'ffffffffffffffffffffffffffffffff'
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('body')])

function png(headers: Record<string, string> = {}, body: BodyInit = new Uint8Array(PNG)): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/png', ...headers } })
}

function fetcher(response: Response | Error, overrides: Partial<ConstructorParameters<typeof ChartFetcher>[0]> = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (response instanceof Error) throw response
    return response
  })
  const instance = new ChartFetcher({
    baseUrl: 'http://charts.test:8095', apiKey: 'secret-key', timeoutMs: 1_000, maxBytes: 64, fetch, ...overrides,
  })
  return { instance, fetch }
}

describe('extractChartIds', () => {
  it('reads ids from pretty-printed and truncated JSON, ignoring malformed values', () => {
    const text = `{\n  "chart_id": "${ID}",\n  "x": 1, "chart_id":"${OTHER}" "chart_id": "ABCDEF0123456789ABCDEF0123456789", "chart_id": "short", "chart_id": null}`
    expect(extractChartIds(text)).toEqual([ID, OTHER])
    expect(extractChartIds(`{"chart_id": "${ID}", "caption": "…`)).toEqual([ID])
  })
})

describe('mergeChartIds', () => {
  it('moves repeats to the end and keeps the most recent ids', () => {
    expect(mergeChartIds(['a', 'b'], ['a', 'c'], 2)).toEqual(['a', 'c'])
    expect(mergeChartIds(['a'], ['b', 'b'], 5)).toEqual(['a', 'b'])
  })
})

describe('ChartFetcher', () => {
  it('fetches from the configured base with the API key and no redirects', async () => {
    const { instance, fetch } = fetcher(png(), { baseUrl: 'http://charts.test:8095/prefix' })
    await expect(instance.fetchPng(ID, new AbortController().signal)).resolves.toEqual(PNG)
    const [url, init] = fetch.mock.calls[0] as [URL, RequestInit]
    expect(url.href).toBe(`http://charts.test:8095/prefix/charts/${ID}.png`)
    expect(init.headers).toEqual({ 'X-API-Key': 'secret-key' })
    expect(init.redirect).toBe('error')
  })

  it.each([
    ['status', new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }), 'HTTP 404'],
    ['content type', png({ 'content-type': 'text/html' }), 'unexpected content-type text/html'],
    ['declared size', png({ 'content-length': '65' }), '65 bytes exceeds 64'],
    ['streamed size', png({}, new Uint8Array(65)), 'body exceeds 64 bytes'],
    ['signature', png({}, new Uint8Array(10)), 'not a PNG'],
  ])('rejects a bad %s without leaking the key', async (_name, response, message) => {
    const { instance } = fetcher(response)
    let error: Error | undefined
    try {
      await instance.fetchPng(ID, new AbortController().signal)
    } catch (failure: unknown) {
      error = failure as Error
    }
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toContain(message)
    expect(error?.message).toContain('chart 01234567')
    expect(error?.message).not.toContain('secret-key')
  })

  it('rejects malformed ids before any request and non-http bases at construction', async () => {
    const { instance, fetch } = fetcher(png())
    await expect(instance.fetchPng('../../etc/passwd', new AbortController().signal)).rejects.toThrow('malformed id')
    expect(fetch).not.toHaveBeenCalled()
    expect(() => new ChartFetcher({ baseUrl: 'file:///tmp', apiKey: 'k', timeoutMs: 1, maxBytes: 1 })).toThrow('http(s)')
  })

  it('propagates caller cancellation', async () => {
    const controller = new AbortController()
    controller.abort(new Error('disposed'))
    const fetch = vi.fn(async (_url: URL, init: RequestInit) => {
      init.signal?.throwIfAborted()
      return png()
    })
    const instance = new ChartFetcher({ baseUrl: 'http://charts.test', apiKey: 'k', timeoutMs: 1_000, maxBytes: 64,
      fetch: fetch as unknown as typeof globalThis.fetch })
    await expect(instance.fetchPng(ID, controller.signal)).rejects.toThrow('disposed')
  })
})
