/**
 * Chart images produced by an allowlisted MCP tool and delivered after the text reply.
 *
 * The model never names a URL: the runtime collects `chart_id` values only from the
 * successful results of the configured tools in the current turn, and this fetcher
 * builds the address from deployment configuration alone.
 */

/** A 128-bit hex chart id as issued by the chart-producing tool. */
const CHART_ID = /^[0-9a-f]{32}$/
/** Matches `"chart_id": "<id>"` in a tool's JSON text, tolerant of pretty-printing and later truncation. */
const CHART_ID_FIELD = /"chart_id"\s*:\s*"([0-9a-f]{32})"/g
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Extract every chart id from one tool-result text, in order of appearance.
 * @param text - the tool result text the model saw.
 * @returns the well-formed ids; malformed values are ignored.
 */
export function extractChartIds(text: string): string[] {
  return [...text.matchAll(CHART_ID_FIELD)].map(match => match[1]).filter((id): id is string => id !== undefined)
}

/**
 * Record ids from the newest tool result, keeping the most recent `limit` distinct ids.
 * @param current - ids already collected in this turn, oldest first.
 * @param added - ids from the newest result.
 * @param limit - maximum ids retained.
 * @returns a new list; an id seen again moves to the end.
 */
export function mergeChartIds(current: readonly string[], added: readonly string[], limit: number): string[] {
  const merged = current.filter(id => !added.includes(id))
  for (const id of added) if (!merged.includes(id)) merged.push(id)
  return merged.slice(Math.max(0, merged.length - limit))
}

/** Options for {@link ChartFetcher}. */
export interface ChartFetcherOptions {
  /** Absolute http(s) base; images are read from `charts/<id>.png` beneath it. */
  readonly baseUrl: string
  /** Value sent as `X-API-Key`. */
  readonly apiKey: string
  readonly timeoutMs: number
  readonly maxBytes: number
  /** Injected for tests. */
  readonly fetch?: typeof globalThis.fetch
}

/** Fetch one stored chart PNG from the chart-producing service. */
export class ChartFetcher {
  private readonly base: URL
  private readonly fetchImpl: typeof globalThis.fetch

  /** @param options - deployment-owned address, credential, and limits. */
  constructor(private readonly options: ChartFetcherOptions) {
    const base = new URL(options.baseUrl)
    if (base.protocol !== 'http:' && base.protocol !== 'https:') {
      throw new Error('channel-wecom: chartAttachments.baseUrl must be an http(s) URL')
    }
    this.base = base.pathname.endsWith('/') ? base : new URL(`${base.pathname}/`, base)
    this.fetchImpl = options.fetch ?? globalThis.fetch
  }

  /**
   * Read and validate one chart image.
   * @param chartId - an id collected from an allowlisted tool result.
   * @param signal - cancels the request together with the per-fetch timeout.
   * @returns the PNG bytes.
   */
  async fetchPng(chartId: string, signal: AbortSignal): Promise<Buffer> {
    const label = chartId.slice(0, 8)
    if (!CHART_ID.test(chartId)) throw new Error(`chart ${label}: malformed id`)
    const url = new URL(`charts/${chartId}.png`, this.base)
    // Defence in depth: the id regex already excludes path syntax.
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) {
      throw new Error(`chart ${label}: resolved outside the configured base`)
    }
    const response = await this.fetchImpl(url, {
      headers: { 'X-API-Key': this.options.apiKey },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
    })
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`chart ${label}: HTTP ${response.status}`)
    }
    const type = response.headers.get('content-type') ?? ''
    if (!type.startsWith('image/png')) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`chart ${label}: unexpected content-type ${type || '(none)'}`)
    }
    const declared = Number(response.headers.get('content-length') ?? Number.NaN)
    if (Number.isFinite(declared) && declared > this.options.maxBytes) {
      await response.body?.cancel().catch(() => {})
      throw new Error(`chart ${label}: ${declared} bytes exceeds ${this.options.maxBytes}`)
    }
    const png = await readBounded(response, this.options.maxBytes, label)
    if (png.length < PNG_SIGNATURE.length || !png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`chart ${label}: body is not a PNG`)
    }
    return png
  }
}

async function readBounded(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  if (response.body === null) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new Error(`chart ${label}: body exceeds ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
