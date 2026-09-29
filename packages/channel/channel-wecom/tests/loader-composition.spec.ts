/** Enterprise WeCom output over real durable Sessions, archive admission, and Loader-owned services. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import Workspace from '@deepseek-ai/dsh-workspace'
import Shell from '@deepseek-ai/dsh-bash-sandbox'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval from '@deepseek-ai/dsh-user-approval'
import Permissions from '@deepseek-ai/dsh-permission-presets'
import Title from '@deepseek-ai/dsh-session-title'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import Preset from '@deepseek-ai/dsh-agent-preset'
import { afterEach, expect, it, vi } from 'vitest'
import { ArchivedSessionGate } from '../../../api/session-controller/src/archived-session-gate.ts'
import { Config, type ResolvedConfig } from '../src/config.ts'
import { channelWeComDomainSpec } from '../src/domain.ts'
import { conversationIdentity } from '../src/identity.ts'
import { WeComChannelRuntime } from '../src/runtime.ts'
import { weComScheduledActionDomainSpec } from '../src/scheduled-action-domain.ts'
import { weComScheduledActionInputDomainSpec } from '../src/scheduled-action-input-domain.ts'
import type { WeComChannelClient } from '../src/types.ts'

class Adapter extends LlmAdapter {
  requests = 0
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests++
    yield { type: 'text-delta', index: 0, text: '恢复成功' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class Client implements WeComChannelClient {
  listener: ((frame: unknown) => void) | undefined
  final = Promise.withResolvers<string>()
  connect(): Promise<void> { return Promise.resolve() }
  disconnect(): Promise<void> { return Promise.resolve() }
  onText(listener: (frame: unknown) => void): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }
  onAuthenticated(): () => void { return () => {} }
  createStreamId(): string { return 'stream' }
  replyStream(_frame: unknown, _id: string, content: string, finish: boolean): Promise<void> {
    if (finish) this.final.resolve(content)
    return Promise.resolve()
  }
  sendMarkdown(_target: string, content: string): Promise<void> { this.final.resolve(content); return Promise.resolve() }
}

let root: string | undefined
let context: Context | undefined
let runtime: WeComChannelRuntime | undefined
afterEach(async () => {
  await runtime?.close()
  runtime = undefined
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('reports archive admission failure and resumes the same conversation after restoration', { timeout: 30_000 }, async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-wecom-loader-'))
  const ctx = new Context()
  context = ctx
  const warnings = vi.spyOn(ctx.logger, 'warn')
  ctx.provide('fixtureRoot', root)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: LlmRuntime, session: SessionStore, projections: Projections,
    'system-prompt': SystemPrompt, tools: Tools, agents: Agents, loop: Loop,
    persistence: Persistence, storage: Storage, 'storage-json': StorageJson,
    'storage-domain': StorageDomain, workspace: Workspace, 'archive-gate': ArchivedSessionGate,
    shell: Shell, approval: Approval, permissions: Permissions, title: Title, presets: Presets, preset: Preset,
    subprocess: Subprocess, sandbox: Sandbox, 'sandbox-policy': SandboxPolicy,
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/blocked.cordis.yml', import.meta.url).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.permissionPresets).toBeDefined()
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['fixture'], adapter)
  const workspace = await ctx.workspaceRegistry.create(root)
  const delivery = {
    messageId: 'one', requestId: 'request', botId: 'bot', chatType: 'single' as const,
    userId: 'user', target: 'user', text: 'hello', frame: {},
  }
  const { sessionId } = conversationIdentity('bot', 'identity', 'shared', delivery)
  const handle = await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
  await ctx.sessions.flush(handle.agent.session)
  await handle.dispose()
  await ctx.workspaceRegistry.archiveSession(sessionId)
  const domain = await ctx.storageDomain.open(channelWeComDomainSpec)
  const client = new Client()
  runtime = new WeComChannelRuntime(ctx, {
    config: Config({
      botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'KEY', workspacePath: root,
      agentPreset: 'empty', permissionPreset: 'unattended', allowedUsers: ['user'], allowedChats: [],
      messages: { processing: '处理中', timeout: '超时', failure: '任务失败，请检查会话状态',
        emptyReply: '任务已完成，但没有文本回复。', unauthorized: '未授权', duplicate: '重复',
        scheduledActionSuccess: '成功', scheduledActionFailure: '失败', scheduledActionUncertain: '未知',
        scheduledActionDefinitionUnavailable: '不可用' },
    }) as ResolvedConfig,
    client, domain, identitySecret: 'identity', workspace,
    scheduledActionDomain: await ctx.storageDomain.open(weComScheduledActionDomainSpec),
    scheduledActionInputDomain: await ctx.storageDomain.open(weComScheduledActionInputDomainSpec),
    modelSelection: { provider: 'fixture', model: 'fixture' },
  })
  await runtime.start()
  const frame = (messageId: string) => ({ headers: { req_id: messageId }, body: {
    msgid: messageId, aibotid: 'bot', chattype: 'single', from: { userid: 'user' },
    msgtype: 'text', text: { content: 'hello' },
  } })
  client.listener?.(frame('one'))
  const blockedReply = await client.final.promise
  expect(blockedReply).toBe('任务失败，请检查会话状态')
  await vi.waitFor(() => {
    expect([...domain.table('deliveries').entries()].map(([, record]) => record.state)).toEqual(['failed'])
  })
  expect(adapter.requests).toBe(0)
  expect(ctx.workspaceRegistry.archivedSessionIds).toContain(sessionId)
  await ctx.workspaceRegistry.unarchiveSession(sessionId)
  client.final = Promise.withResolvers<string>()
  client.listener?.(frame('two'))
  expect(await client.final.promise, JSON.stringify(warnings.mock.calls)).toBe('恢复成功')
  await vi.waitFor(() => {
    expect([...domain.table('deliveries').entries()].map(([, record]) => record.state)).toEqual(['failed', 'completed'])
  })
  expect(adapter.requests).toBe(1)
  await runtime.close()
  await using stored = await ctx.sessionPersistence.open(sessionId, 'read')
  const history = await stored.read()
  expect(history.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['blocked', 'completed'])
  expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(sessionId)
  await expect(JSON.stringify({
    replies: [blockedReply, await client.final.promise],
    turns: history.events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind),
    modelRequests: adapter.requests,
    archived: ctx.workspaceRegistry.archivedSessionIds.includes(sessionId),
  }, null, 2) + '\n').toMatchFileSnapshot('./expected/archive-recovery.json')
})
