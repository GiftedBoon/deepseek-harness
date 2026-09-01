/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './rpc.ts'

const AUTH_RECORD_KEY = credentialKey('client-connection', 'browser-session')
const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 1
const STORED_SECRET_VERSION = 1
const LOGIN_BODY_MAX_BYTES = 8 * 1024
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_LAUNCH_TOKENS = new WeakMap<object, string>()

interface LoginCopy {
  readonly language: string
  readonly title: string
  readonly username: string
  readonly password: string
  readonly submit: string
  readonly failure: string
}

const LOGIN_COPY = {
  en: {
    language: 'en',
    title: 'Sign in to DeepSeek Harness',
    username: 'Username',
    password: 'Password',
    submit: 'Sign in',
    failure: 'Incorrect username or password.',
  },
  zh: {
    language: 'zh-CN',
    title: '登录 DeepSeek Harness',
    username: '用户名',
    password: '密码',
    submit: '登录',
    failure: '用户名或密码错误。',
  },
} as const satisfies Record<'en' | 'zh', LoginCopy>

interface StoredSecretPayload {
  readonly version: typeof STORED_SECRET_VERSION
  readonly secret: string
}

interface BrowserCookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
}

/** Credentials resolved by the optional browser form-login deployment. */
export interface PasswordLogin {
  readonly username: string
  readonly resolvePassword: () => Promise<string | undefined>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

function processLaunchToken(owner: object): string {
  const existing = PROCESS_LAUNCH_TOKENS.get(owner)
  if (existing !== undefined) return existing
  const created = encodeBase64Url(randomBytes(SECRET_BYTES))
  PROCESS_LAUNCH_TOKENS.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Canonical request authority used as the cookie name and signed audience. */
function requestAuthority(headers: ConnectionTrustRequest['headers']): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    return new URL(`http://${host}`).host
  } catch {
    return undefined
  }
}

function canonicalSecret(value: unknown): Buffer | undefined {
  if (typeof value !== 'string') return undefined
  const decoded = decodeBase64Url(value)
  if (decoded === undefined || decoded.byteLength !== SECRET_BYTES) return undefined
  return decoded
}

function storedSecret(record: CredentialRecord | undefined): Buffer | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant' || !isRecord(record.payload)
    || record.payload.version !== STORED_SECRET_VERSION) {
    throw new Error('client-connection: browser-session credential record has an unsupported format')
  }
  const secret = canonicalSecret(record.payload.secret)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record has an invalid secret')
  }
  return secret
}

function constantTimeMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function loginCopy(headers: ConnectionTrustRequest['headers']): LoginCopy {
  const accepted = header(headers, 'accept-language')
  if (accepted === undefined) return LOGIN_COPY.en
  for (const item of accepted.toLowerCase().split(',')) {
    const [language = '', ...parameters] = item.trim().split(';')
    if (parameters.some(parameter => /^q=0(?:\.0*)?$/u.test(parameter.trim()))) continue
    const baseLanguage = language.split('-', 1)[0]
    if (baseLanguage === 'zh') return LOGIN_COPY.zh
    if (baseLanguage === 'en') return LOGIN_COPY.en
  }
  return LOGIN_COPY.en
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(name: string, value: string, expiresAt: number, maxAgeSeconds: number): string {
  return `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

function encodeCookie(payload: BrowserCookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v1.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): BrowserCookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== 'v1' || body === undefined || encodedSignature === undefined) {
    return undefined
  }
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || !Number.isSafeInteger(decoded.issuedAt)
    || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  return decoded as unknown as BrowserCookiePayload
}

async function initializeSecret(credentials: CredentialProvider): Promise<Buffer> {
  const generated: StoredSecretPayload = {
    version: STORED_SECRET_VERSION,
    secret: encodeBase64Url(randomBytes(SECRET_BYTES)),
  }
  const record = await credentials.modifyRecord(AUTH_RECORD_KEY, (current) => {
    if (current !== undefined) {
      storedSecret(current)
      return Promise.resolve(undefined)
    }
    return Promise.resolve({ kind: 'grant', payload: generated })
  })
  const secret = storedSecret(record)
  if (secret === undefined) {
    throw new Error('client-connection: browser-session credential record was not created')
  }
  return secret
}

/**
 * Process launch-token exchange and persistent signed-cookie verification.
 * Connection loads the credential provider's signing secret during activation
 * and retains it for synchronous request authentication.
 */
export class BrowserAuth {
  private readonly launchToken: string
  private readonly maxAgeMilliseconds: number

  private constructor(
    processOwner: object,
    private readonly secret: Buffer,
    maxAgeDays: number,
    private readonly passwordLogin: PasswordLogin | undefined,
  ) {
    this.launchToken = processLaunchToken(processOwner)
    this.maxAgeMilliseconds = maxAgeDays * DAY_MILLISECONDS
    if (!Number.isSafeInteger(this.maxAgeMilliseconds)
      || !Number.isSafeInteger(Date.now() + this.maxAgeMilliseconds)) {
      throw new Error('client-connection: cookieMaxAgeDays exceeds the safe timestamp range')
    }
  }

  /**
   * Initialize browser authentication and create its durable signing secret
   * when this Harness home has none.
   * @param processOwner - root application context retaining one token across Connection reloads.
   * @param credentials - persistent credential provider for the Web profile.
   * @param maxAgeDays - positive absolute browser-cookie lifetime in days.
   * @returns initialized authentication owner with the process owner's launch token.
   */
  static async create(
    processOwner: object,
    credentials: CredentialProvider,
    maxAgeDays: number,
    passwordLogin?: PasswordLogin,
  ): Promise<BrowserAuth> {
    return new BrowserAuth(processOwner, await initializeSecret(credentials), maxAgeDays, passwordLogin)
  }

  /**
   * Add this process's launch token to the ordinary application root URL.
   * @param baseUrl - canonical browser origin without credentials.
   * @returns root URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.pathname = '/'
    url.search = ''
    url.hash = ''
    url.searchParams.set(TOKEN_QUERY, this.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to clean `/`; a valid cookie lets the caller serve the
   * index; every other request receives the same minimal 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAuthority(req.headers)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && constantTimeMatches(tokens.join(''), this.launchToken)) {
        this.issueSession(authority, res)
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': '/',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @returns true only for an unexpired cookie signed by this activation's loaded secret.
   */
  isAuthenticated(request: ConnectionTrustRequest): boolean {
    const authority = requestAuthority(request.headers)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return false
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return false
    const payload = decodeCookie(value, this.secret)
    if (payload === undefined || payload.authority !== authority) return false
    const now = Date.now()
    return payload.issuedAt <= now
      && payload.expiresAt > now
      && payload.expiresAt > payload.issuedAt
      && payload.expiresAt - payload.issuedAt <= this.maxAgeMilliseconds
  }

  /** Serve the optional form login and exchange valid credentials for the normal browser cookie. */
  async handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const passwordLogin = this.passwordLogin
    if (passwordLogin === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    if (this.isAuthenticated(req)) {
      redirectHome(res)
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      this.writeLoginPage(req, res, passwordLogin, req.method === 'HEAD', false)
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'GET, HEAD, POST' })
      res.end()
      return
    }
    const mediaType = header(req.headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/x-www-form-urlencoded') {
      res.writeHead(415)
      res.end('content type must be application/x-www-form-urlencoded')
      return
    }
    const body = await readLoginBody(req)
    if (body === undefined) {
      res.writeHead(413, { 'cache-control': 'no-store', connection: 'close' })
      res.end()
      return
    }
    const form = new URLSearchParams(body)
    const usernames = form.getAll('username')
    const passwords = form.getAll('password')
    const suppliedUsername = usernames.length === 1 ? usernames[0] : undefined
    const suppliedPassword = passwords.length === 1 ? passwords[0] : undefined
    const expectedPassword = await passwordLogin.resolvePassword()
    const authority = requestAuthority(req.headers)
    if (authority === undefined || expectedPassword === undefined
      || suppliedUsername !== passwordLogin.username || suppliedPassword === undefined
      || !constantTimeMatches(suppliedPassword, expectedPassword)) {
      this.writeLoginPage(req, res, passwordLogin, false, true)
      return
    }
    this.issueSession(authority, res)
  }

  private issueSession(authority: string, res: ConnectionIndexResponse): void {
    const issuedAt = Date.now()
    const expiresAt = issuedAt + this.maxAgeMilliseconds
    const value = encodeCookie({ version: COOKIE_PAYLOAD_VERSION, authority, issuedAt, expiresAt }, this.secret)
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': '/',
      'referrer-policy': 'no-referrer',
      'set-cookie': sessionCookie(cookieName(authority), value, expiresAt, Math.floor(this.maxAgeMilliseconds / 1000)),
    })
    res.end()
  }

  private writeLoginPage(
    req: IncomingMessage,
    res: ServerResponse,
    passwordLogin: PasswordLogin,
    head: boolean,
    failed: boolean,
  ): void {
    const copy = loginCopy(req.headers)
    const username = escapeHtml(passwordLogin.username)
    const failure = failed ? `<p class="error" id="login-error" role="alert">${copy.failure}</p>` : ''
    const describedBy = failed ? ' aria-describedby="login-error"' : ''
    const body = `<!doctype html><html lang="${copy.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title><style>body{font-family:system-ui,sans-serif;background:#f5f6f8;margin:0;display:grid;min-height:100vh;place-items:center}.card{background:#fff;padding:32px;border-radius:12px;box-shadow:0 8px 32px #0002;width:min(360px,calc(100vw - 48px))}h1{font-size:22px;margin:0 0 24px}label{display:block;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #bbb;border-radius:6px}button{width:100%;margin-top:24px;padding:11px;border:0;border-radius:6px;background:#111;color:#fff;font-weight:600}.error{color:#b42318}</style></head><body><main class="card"><h1>${copy.title}</h1>${failure}<form method="post" action="/login"><label for="username">${copy.username}</label><input id="username" name="username" autocomplete="username" value="${username}" required><label for="password">${copy.password}</label><input id="password" type="password" name="password" autocomplete="current-password" autofocus required${describedBy}><button type="submit">${copy.submit}</button></form></main></body></html>`
    res.writeHead(failed ? 401 : 200, {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'content-language': copy.language,
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    res.end(head ? undefined : body)
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    if (this.passwordLogin !== undefined && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(303, { 'cache-control': 'no-store', 'location': '/login' })
      res.end()
      return
    }
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }
}

function redirectHome(res: ServerResponse): void {
  res.writeHead(303, { 'cache-control': 'no-store', location: '/' })
  res.end()
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

async function readLoginBody(req: IncomingMessage): Promise<string | undefined> {
  const contentLength = header(req.headers, 'content-length')
  if (contentLength !== undefined && /^\d+$/u.test(contentLength)
    && Number(contentLength) > LOGIN_BODY_MAX_BYTES) {
    req.resume()
    return undefined
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk)
    size += bytes.byteLength
    if (size > LOGIN_BODY_MAX_BYTES) return undefined
    chunks.push(bytes)
  }
  return Buffer.concat(chunks).toString('utf8')
}
