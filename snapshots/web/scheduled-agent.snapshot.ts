/** Real dsh Web profile replay of an Agent-created scheduled pre-open check. */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import {
  formatSystemPromptSnapshot, formatToolSchemasSnapshot, normalizedSystemPrompts, normalizedToolSchemas,
  latestPersistedSessionPaths, materializeProfilePatch, normalizeSessionLog, normalizeSessionSnapshots,
  redactSessionSnapshotIds, scrubSessionSnapshot, sessionFixtureNames, sessionFixtureName,
} from '@deepseek-ai/dsh-session-snapshot'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

const repoRoot = resolve(import.meta.dirname, '../..')
const fixtureDir = fileURLToPath(new URL('./scheduled-preopen/', import.meta.url))
const mode = process.env.DSH_SNAPSHOT ?? 'replay'
const authoring = process.env.DSH_PREOPEN_AUTHOR === '1'

it('scheduled-preopen replays an Agent-created task through the shipped Web Host', async () => {
  const world = await mkdtemp(join(tmpdir(), 'dsh-scheduled-session-'))
  let child: ReturnType<typeof spawn> | undefined
  let childClosed: Promise<unknown> | undefined
  let output = ''
  try {
    const skills = join(world, 'skills')
    await cp(join(repoRoot, 'deployments/trader-ops/skills'), skills, { recursive: true })
    const fixtureNames = await readdir(fixtureDir)
    const selected = authoring && !fixtureNames.some(name => /^session(?:\.v\d+)?\.jsonl$/.test(name)) ? undefined : sessionFixtureNames(fixtureNames)[0]
    if (!authoring && selected === undefined) throw new Error('Missing committed scheduled-preopen Session')
    const input = selected === undefined ? '' : await readFile(join(fixtureDir, selected), 'utf8')
    const user = input.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { type: string; data?: { source?: { kind: string }; content?: Array<{ type: string; text?: string }> } })
      .find(event => event.type === 'user/message' && event.data?.source?.kind === 'user')
    const prompt = authoring ? '在本会话创建一秒后执行的预开启检查任务。使用 preopen-watch，核验 2026-10-13 交易日并报告检测结果。' : user?.data?.content?.find(block => block.type === 'text')?.text
    if (prompt === undefined) throw new Error('Committed Session has no user task')
    const patchRoot = join(world, 'patches')
    await mkdir(patchRoot)
    const livePatch = materializeProfilePatch(join(fixtureDir, 'cordis.yml'), world, 'web', patchRoot, 0)
    const replayPatch = materializeProfilePatch(join(fixtureDir, 'cordis.snapshot.yml'), world, 'web', patchRoot, 1)
    const launch = resolveExampleLaunch({ srcBin: join(repoRoot, 'apps/cli/src/bin.ts'), tsconfigPath: join(repoRoot, 'tsconfig.json'), sourceImport: 'tsx/esm',
      configArgs: ['--profile', 'web', '--patch', join(repoRoot, 'packages/experimental/schedule-bundle/cordis.patch.yml'), '--patch', livePatch, '--patch', replayPatch, '--no-open', '--port', '0'],
    })
    child = spawn(launch.command, launch.args, { cwd: world, env: { ...process.env, ...launch.env,
      DSH_HOME: join(world, 'home'), DSH_AGENTS_HOME: join(world, 'agents'), DSH_PERMISSION_MODE: 'danger-full-access',
      DSH_PREOPEN_SKILLS: skills, DSH_PREOPEN_SESSIONS: join(world, 'sessions'), DSH_TELEMETRY_DISABLED: '1',
      DSH_SNAPSHOT_FILE: selected === undefined ? '' : join(fixtureDir, selected), DEEPSEEK_API_KEY: '',
      NODE_OPTIONS: '--disable-warning=ExperimentalWarning',
    }, stdio: ['ignore', 'pipe', 'pipe'] })
    childClosed = new Promise(resolveClosed => { child!.once('close', resolveClosed) })
    const ready = Promise.withResolvers<string>()
    const receive = (chunk: Buffer): void => {
      output += chunk.toString()
      const url = /dsh web: (http:\/\/[^\s]+)/u.exec(output)?.[1]
      if (url !== undefined) ready.resolve(url)
      if (output.includes('dsh: startup failed:')) ready.reject(new Error(output.slice(0, 12000)))
    }
    child.stdout!.on('data', receive)
    child.stderr!.on('data', receive)
    child.once('error', error => { ready.reject(error) })
    child.once('close', () => { ready.reject(new Error(output.slice(0, 12000))) })
    const startupTimeout = setTimeout(() => { ready.reject(new Error('Web startup timeout\n' + output.slice(0, 12000))) }, 60_000)
    let loginUrl: string
    try { loginUrl = await ready.promise } finally { clearTimeout(startupTimeout) }
    const baseUrl = new URL(loginUrl).origin
    const login = await fetch(loginUrl, { redirect: 'manual' })
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    expect(cookie, output).toBeDefined()
    let rpcOrdinal = 0
    const rpc = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
      const response = await fetch(`${baseUrl}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie!, origin: baseUrl },
        body: JSON.stringify({ type: 'client-request', rpcId: `snapshot-${++rpcOrdinal}`, method, payload: { args } }) })
      const reply = await response.json() as { result: { ok: boolean; value?: unknown; error?: unknown } }
      if (!reply.result?.ok) throw new Error(JSON.stringify(reply) + '\n' + output)
      return reply.result.value
    }
    const created = await rpc('session/create', { request: { cwd: world } }) as { sessionId: string }
    await rpc('session/prompt', { request: { sessionId: created.sessionId, requestId: 'scheduled-preopen-request', mode: 'queue', clientTimeZone: 'Asia/Shanghai', content: [{ type: 'text', text: prompt }] } })
    const harvest = async (): Promise<string> => {
      if (!existsSync(join(world, 'sessions'))) return ''
      const paths = latestPersistedSessionPaths(await readdir(join(world, 'sessions'), { recursive: true }))
      return paths.length === 0 ? '' : readFile(join(world, 'sessions', paths[0]!), 'utf8')
    }
    await expect.poll(async () => (await harvest()).includes('已创建预开启检查任务。'), { timeout: 30_000 }).toBe(true)
    const advanced = await fetch(`${baseUrl}/snapshot-clock`)
    expect(advanced.status).toBe(200)
    await expect.poll(async () => (await harvest()).includes('当夜守护结束。'), { timeout: 30_000 }).toBe(true)
    await expect.poll(async () => {
      const runs = await rpc('schedule/executions', { request: { sessionId: created.sessionId, limit: 10 } }) as Array<{ status: string }>
      return runs.length === 1 && runs[0]?.status === 'completed'
    }, { timeout: 30_000 }).toBe(true)
    const raw = await harvest()
    const results = raw.trim().split('\n').map(line => JSON.parse(line) as { type: string; data?: { message?: { isError?: boolean; toolCallId?: string; content?: Array<{ type: string; text?: string }> } } })
      .filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data?.message?.isError)).toEqual(Array(6).fill(false))
    expect(results.find(event => event.data?.message?.toolCallId === 'scheduled-preopen-3')?.data?.message?.content?.[0]?.text)
      .toContain('<skill_content name="preopen-watch">')
    const stored = JSON.parse(await readFile(join(world, 'home/storages/schedule_execution.json'), 'utf8')) as {
      tables: { states: Record<string, { revision: number; value: Record<string, unknown> }> }
    }
    expect(Object.values(stored.tables.states)).toMatchObject([{ revision: 1, value: { target: '2026-10-13', done: true, checks: 1 } }])
    expect(raw).toContain('schedule_state_write')
    expect(raw).toContain('Scheduled task: 预开启守护快照')
    expect(raw).toContain('mcp__bssh-ops-remote__check_daily_preopen')
    const context = { cwd: world, sessionIds: [created.sessionId] }
    const prompts = normalizedSystemPrompts(raw, context)
    const schemas = normalizedToolSchemas(raw, context)
    const pinned = [
      ['system-prompt.expected.md', formatSystemPromptSnapshot(prompts[0]!, prompts.slice(1))],
      ['tool-schemas.expected.json', formatToolSchemasSnapshot(schemas)],
    ] as const
    if (mode === 'refresh' || mode === 'record') {
      const normalized = scrubSessionSnapshot(normalizeSessionLog(redactSessionSnapshotIds([raw])[0]!, context, { identityMode: 'preserve' }))
      await writeFile(join(fixtureDir, sessionFixtureName(0, SESSION_FORMAT_VERSION)), normalized)
      for (const [filename, value] of pinned) await writeFile(join(fixtureDir, filename), value)
    } else {
      expect(normalizeSessionSnapshots([raw], context)).toEqual(normalizeSessionSnapshots([input], { cwd: '{{cwd}}', sessionIds: [] }))
      for (const [filename, value] of pinned) expect(value).toBe(await readFile(join(fixtureDir, filename), 'utf8'))
    }
  } finally {
    child?.kill('SIGTERM')
    if (childClosed !== undefined) {
      const terminateTimeout = setTimeout(() => { child?.kill('SIGKILL') }, 10_000)
      try { await childClosed } finally { clearTimeout(terminateTimeout) }
    }
    await rm(world, { recursive: true, force: true })
  }
})
