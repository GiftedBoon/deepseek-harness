/** Browser launch-token and persistent-cookie behavior. */

import { createHmac } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { BrowserAuth } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/rpc.ts'
import { RecordCredentials } from './browser-credentials.ts'

function signedCookie(store: RecordCredentials, name: string, payload: unknown): string {
  const body = typeof payload === 'string'
    ? Buffer.from(payload, 'utf8').toString('base64url')
    : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return signedBodyCookie(store, name, body)
}

function signedBodyCookie(store: RecordCredentials, name: string, body: string): string {
  const record = store.record
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null) {
    throw new Error('test credential store has no signing secret')
  }
  const secret: unknown = Reflect.get(record.payload, 'secret')
  if (typeof secret !== 'string') throw new Error('test credential record has no string secret')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v1.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function loginRequest(method: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const request = Readable.from(body === '' ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(request, {
    method,
    url: '/login',
    headers: { host: 'harness.internal:9000', ...headers },
  })
  return request
}

function serverResponse(): { value: ServerResponse; state: ResponseState } {
  const { value, state } = response()
  return { value: Object.assign(new EventEmitter(), value) as unknown as ServerResponse, state }
}

function credentials(store: RecordCredentials): CredentialProvider {
  return store as unknown as CredentialProvider
}

function createAuth(
  store: RecordCredentials,
  maxAgeDays = 30,
  processOwner: object = {},
): Promise<BrowserAuth> {
  return BrowserAuth.create(processOwner, credentials(store), maxAgeDays)
}

function request(url: string, authority = '127.0.0.1:3080', init?: {
  cookie?: string
  method?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
    },
  }
}

function exchange(
  auth: BrowserAuth,
  authority = '127.0.0.1:3080',
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`http://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserAuth', () => {
  it('serves password login and issues the existing authority-bound cookie', async () => {
    let password: string | undefined = 'correct horse battery staple'
    const auth = await BrowserAuth.create({}, credentials(new RecordCredentials()), 30, {
      username: 'trader',
      resolvePassword: () => Promise.resolve(password),
    })
    const page = serverResponse()
    await auth.handleLogin(loginRequest('GET', '', { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' }), page.value)
    expect(page.state).toMatchObject({ status: 200 })
    expect(page.state.body).toContain('登录 DeepSeek Harness')
    expect(page.state.body).toContain('value="trader"')

    const english = serverResponse()
    await auth.handleLogin(loginRequest('HEAD', '', { 'accept-language': 'en-US,en;q=0.9' }), english.value)
    expect(english.state).toMatchObject({
      status: 200,
      headers: { 'content-language': 'en' },
    })
    expect(english.state.body).toBeUndefined()

    const fallback = serverResponse()
    await auth.handleLogin(loginRequest('GET', '', { 'accept-language': 'zh;q=0,fr-FR;q=0.9' }), fallback.value)
    expect(fallback.state.headers).toMatchObject({ 'content-language': 'en' })
    expect(fallback.state.body).toContain('Sign in to DeepSeek Harness')

    const root = response()
    expect(auth.authorizeIndex(request('/'), root.value)).toBe(false)
    expect(root.state).toMatchObject({ status: 303, headers: { location: '/login' } })
    const headRoot = response()
    expect(auth.authorizeIndex(request('/', '127.0.0.1:3080', { method: 'HEAD' }), headRoot.value)).toBe(false)
    expect(headRoot.state).toMatchObject({ status: 303, headers: { location: '/login' } })

    const rejected = serverResponse()
    await auth.handleLogin(loginRequest('POST', 'username=trader&password=wrong', {
      'content-type': 'application/x-www-form-urlencoded',
    }), rejected.value)
    expect(rejected.state).toMatchObject({ status: 401 })
    expect(rejected.state.body).toContain('Incorrect username or password.')

    for (const malformed of ['password=wrong', 'username=trader']) {
      const malformedResponse = serverResponse()
      await auth.handleLogin(loginRequest('POST', malformed, {
        'content-type': 'application/x-www-form-urlencoded',
      }), malformedResponse.value)
      expect(malformedResponse.state.status).toBe(401)
    }

    password = 'rotated password'
    const accepted = serverResponse()
    await auth.handleLogin(loginRequest('POST', 'username=trader&password=rotated+password', {
      'content-type': 'application/x-www-form-urlencoded',
    }), accepted.value)
    expect(accepted.state).toMatchObject({ status: 303, headers: { location: '/' } })
    const cookie = accepted.state.headers?.['set-cookie']?.split(';', 1)[0]
    expect(cookie).toBeDefined()
    if (cookie === undefined) throw new Error('password login did not set a cookie')
    expect(auth.isAuthenticated(request('/', 'harness.internal:9000', { cookie }))).toBe(true)

    const alreadyAuthenticated = serverResponse()
    await auth.handleLogin(loginRequest('GET', '', { cookie }), alreadyAuthenticated.value)
    expect(alreadyAuthenticated.state).toMatchObject({ status: 303, headers: { location: '/' } })

    const oversized = serverResponse()
    await auth.handleLogin(loginRequest('POST', '', {
      'content-length': '8193',
      'content-type': 'application/x-www-form-urlencoded',
    }), oversized.value)
    expect(oversized.state).toMatchObject({ status: 413, headers: { connection: 'close' } })

    const streamedOversized = serverResponse()
    await auth.handleLogin(loginRequest('POST', 'x'.repeat(8193), {
      'content-type': 'application/x-www-form-urlencoded',
    }), streamedOversized.value)
    expect(streamedOversized.state.status).toBe(413)

    const wrongMethod = serverResponse()
    await auth.handleLogin(loginRequest('PUT'), wrongMethod.value)
    expect(wrongMethod.state).toMatchObject({ status: 405, headers: { allow: 'GET, HEAD, POST' } })

    const wrongMediaType = serverResponse()
    await auth.handleLogin(loginRequest('POST', '{}', { 'content-type': 'application/json' }), wrongMediaType.value)
    expect(wrongMediaType.state.status).toBe(415)

    password = undefined
    const removedPassword = serverResponse()
    await auth.handleLogin(loginRequest('POST', 'username=trader&password=rotated+password', {
      'content-type': 'application/x-www-form-urlencoded',
    }), removedPassword.value)
    expect(removedPassword.state.status).toBe(401)

    const disabled = await createAuth(new RecordCredentials())
    const missingRoute = serverResponse()
    await disabled.handleLogin(loginRequest('GET'), missingRoute.value)
    expect(missingRoute.state.status).toBe(404)
  })

  it('mints one process token and a persistent authority-bound cookie', async () => {
    const store = new RecordCredentials()
    const processOwner = {}
    const first = await createAuth(store, 30, processOwner)
    const login = exchange(first)

    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
    expect(login.state.headers?.['set-cookie']).toMatch(/; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(login.state.headers?.['set-cookie']).not.toContain('Secure')
    expect(first.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    expect(first.isAuthenticated({
      headers: new Headers({ host: '127.0.0.1:3080', cookie: login.cookie }),
    })).toBe(true)
    expect(first.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(first.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(first.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)

    const reloaded = await createAuth(store, 30, processOwner)
    expect(reloaded.authenticatedUrl('http://127.0.0.1:3080')).toBe(login.launchUrl)
    expect(reloaded.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)

    const restarted = await createAuth(store)
    expect(new URL(restarted.authenticatedUrl('http://127.0.0.1:3080')).searchParams.get('token'))
      .not.toBe(new URL(login.launchUrl).searchParams.get('token'))
    expect(restarted.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: login.cookie }))).toBe(true)
    const staleUrl = new URL(login.launchUrl)
    const redirected = response()
    expect(restarted.authorizeIndex(request(
      `${staleUrl.pathname}${staleUrl.search}`,
      '127.0.0.1:3080',
      { cookie: login.cookie },
    ), redirected.value)).toBe(false)
    expect(redirected.state).toEqual({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': '/',
        'referrer-policy': 'no-referrer',
      },
    })
  })

  it('accepts the cookie for index serving and gives every unauthenticated request one response', async () => {
    const auth = await createAuth(new RecordCredentials())
    const { cookie } = exchange(auth)
    const allowed = response()
    expect(auth.authorizeIndex(request('/index.html', '127.0.0.1:3080', { cookie }), allowed.value)).toBe(true)
    expect(allowed.state).toEqual({})

    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl('http://127.0.0.1:3080'), '127.0.0.1:3080', { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })

  it('rejects tampering, expiry, future issuance, and a longer lifetime than configured', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
      cookie: signedBodyCookie(store, name, 'a'),
    }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: '127.0.0.1:3080' } })).toBe(false)

    const invalidPayloads: unknown[] = [
      'not json',
      null,
      { version: 2, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: 42, issuedAt: Date.now(), expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: 'now', expiresAt: Date.now() + 1000 },
      { version: 1, authority: '127.0.0.1:3080', issuedAt: Date.now(), expiresAt: 'later' },
    ]
    for (const payload of invalidPayloads) {
      expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', {
        cookie: signedCookie(store, name, payload),
      }))).toBe(false)
    }

    const shorter = await createAuth(store, 1)
    expect(shorter.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-23T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie }))).toBe(false)
  })

  it('loads one secret per activation and replaces it after deletion on the next activation', async () => {
    const store = new RecordCredentials()
    const auth = await createAuth(store)
    const first = exchange(auth)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    await store.deleteRecord()
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(true)
    const sameActivation = exchange(auth)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: sameActivation.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 1 })

    const reactivated = await createAuth(store)
    const second = exchange(reactivated)
    expect(second.cookie).not.toBe(first.cookie)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: first.cookie }))).toBe(false)
    expect(reactivated.isAuthenticated(request('/', '127.0.0.1:3080', { cookie: second.cookie }))).toBe(true)
    expect(store).toMatchObject({ reads: 0, modifies: 2 })
  })

  it('fails loud on an invalid owner record instead of replacing it', async () => {
    const unsupported = new RecordCredentials()
    unsupported.record = { kind: 'api-key', key: 'not-a-cookie-secret' }
    await expect(createAuth(unsupported)).rejects.toThrow(/unsupported format/u)

    const malformed = new RecordCredentials()
    malformed.record = { kind: 'grant', payload: { version: 1, secret: 'short' } }
    await expect(createAuth(malformed)).rejects.toThrow(/invalid secret/u)

    const nonString = new RecordCredentials()
    nonString.record = { kind: 'grant', payload: { version: 1, secret: 42 } }
    await expect(createAuth(nonString)).rejects.toThrow(/invalid secret/u)

    const discarded = new RecordCredentials()
    discarded.discardWrites = true
    await expect(createAuth(discarded)).rejects.toThrow(/was not created/u)

    await expect(createAuth(new RecordCredentials(), Number.MAX_SAFE_INTEGER))
      .rejects.toThrow(/safe timestamp range/u)
  })
})
