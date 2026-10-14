/** Enterprise WeCom output over real durable Sessions, archive admission, and Loader-owned services. */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
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
import { expect } from 'vitest'
import Schedule from '@deepseek-ai/dsh-schedule'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import Typert from '@deepseek-ai/dsh-typert-registry'
import DefaultModel from '@deepseek-ai/dsh-agent-default-model'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import Commands from '@deepseek-ai/dsh-commands'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import Credentials from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import Query from '@deepseek-ai/dsh-session-query'
import Skills from '@deepseek-ai/dsh-skill'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { ArchivedSessionGate } from '../../../api/session-controller/src/archived-session-gate.ts'
import { Config, type ResolvedConfig } from '../src/config.ts'
import { channelWeComDomainSpec } from '../src/domain.ts'
import { conversationIdentity } from '../src/identity.ts'
import { WeComChannelRuntime } from '../src/runtime.ts'
import { weComScheduledActionDomainSpec } from '../src/scheduled-action-domain.ts'
import { weComScheduledActionInputDomainSpec } from '../src/scheduled-action-input-domain.ts'
import type { WeComChannelClient } from '../src/types.ts'


/** Test transport with no external socket; all Agent, Schedule, authority, and storage services are real. */
export class TaskClient implements WeComChannelClient {
  listener: ((frame: unknown) => void) | undefined
  readonly replies: string[] = []
  readonly notifications: { target: string; content: string }[] = []
  failSend = false
  private id = 0
  connect(): Promise<void> { return Promise.resolve() }
  disconnect(): Promise<void> { return Promise.resolve() }
  onText(listener: (frame: unknown) => void): () => void { this.listener = listener; return () => { this.listener = undefined } }
  onAuthenticated(): () => void { return () => {} }
  createStreamId(): string { return `stream-${++this.id}` }
  replyStream(_frame: unknown, _id: string, content: string, finish: boolean): Promise<void> {
    if (finish) this.replies.push(content)
    return Promise.resolve()
  }
  sendMarkdown(target: string, content: string): Promise<void> {
    if (this.failSend) return Promise.reject(new Error('provider unavailable'))
    this.notifications.push({ target, content })
    return Promise.resolve()
  }
  uploadImage(): Promise<string> { return Promise.resolve('media') }
  replyImage(): Promise<void> { return Promise.resolve() }
  sendImage(): Promise<void> { return Promise.resolve() }
  receive(id: string, text: string, group?: string): void {
    this.listener?.({ headers: { req_id: id }, body: {
      msgid: id, aibotid: 'bot', chattype: group === undefined ? 'single' : 'group', ...group === undefined ? {} : { chatid: group }, from: { userid: 'user' }, msgtype: 'text', text: { content: text },
    } })
  }
}

/** Loader-owned real Host services, with only the provider model and WeCom transport substituted. */
export async function taskComposition(adapter: LlmAdapter, options: {
  root?: string
  maxReplyBytes?: number
  allowedUsers?: string[]
  skillsDir?: string
  failSend?: boolean
  taskExecutionRecords?: number
  configure?: (ctx: Context) => void
} = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'dsh-wecom-task-loader-'))
  const ctx = new Context()
  const client = new TaskClient()
  client.failSend = options.failSend ?? false
  let runtime: WeComChannelRuntime | undefined
  ctx.provide('fixtureRoot', root)
  ctx.provide('fixtureTaskExecutionRecords', options.taskExecutionRecords ?? 200)
  if (options.skillsDir !== undefined) await cp(options.skillsDir, join(root, 'skills'), { recursive: true })
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: LlmRuntime, session: SessionStore, projections: Projections,
    'system-prompt': SystemPrompt, tools: Tools, agents: Agents, loop: Loop,
    persistence: Persistence, storage: Storage, 'storage-json': StorageJson,
    'storage-domain': StorageDomain, workspace: Workspace, 'archive-gate': ArchivedSessionGate,
    shell: Shell, approval: Approval, permissions: Permissions, title: Title, presets: Presets, preset: Preset,
    subprocess: Subprocess, sandbox: Sandbox, 'sandbox-policy': SandboxPolicy,
    schedule: Schedule, 'session-controller': SessionController, typert: Typert,
    'default-model': DefaultModel, attachments: Attachments, 'file-uploads': FileUploads,
    commands: Commands, connection: Connection, credentials: Credentials,
    'local-credentials': LocalCredentials, fs: FsLocal, query: Query,
    skills: Skills, 'skill-filesystem': SkillFilesystem, 'tool-skill': ToolSkill,
    'fixture-model': { name: 'fixture-model', inject: ['llm'], apply(owner: Context) {
      owner.effect(() => owner.llm.registerAdapter(['fixture'], adapter))
    } },
    'fixture-channel': { name: 'fixture-channel', inject: ['schedule', 'permissionPresets', 'workspaceRegistry', 'storageDomain', 'agentPresets', 'agents', 'sessions', 'sessionPersistence', 'sessionTitle', 'tools'], async apply(owner: Context) {
      options.configure?.(owner)
      const workspace = await owner.workspaceRegistry.create(root)
      runtime = new WeComChannelRuntime(owner, {
        config: Config({
          botId: 'bot', secretEnv: 'SECRET', sessionKeyEnv: 'KEY', workspacePath: root,
          agentPreset: 'empty', permissionPreset: 'unattended', allowedUsers: options.allowedUsers ?? ['user'], allowedChats: ['other-group'], notificationChatId: 'other-group',
          maxReplyBytes: options.maxReplyBytes ?? 20480,
          outboxRetryIntervalMs: 100,
          messages: { processing: '处理中', timeout: '超时', failure: '任务失败', emptyReply: '无回复', unauthorized: '未授权', duplicate: '重复',
            scheduledActionSuccess: '成功', scheduledActionFailure: '失败', scheduledActionUncertain: '未知', scheduledActionDefinitionUnavailable: '不可用' },
        }) as ResolvedConfig,
        client, domain: await owner.storageDomain.open(channelWeComDomainSpec), identitySecret: 'identity', workspace,
        scheduledActionDomain: await owner.storageDomain.open(weComScheduledActionDomainSpec),
        scheduledActionInputDomain: await owner.storageDomain.open(weComScheduledActionInputDomainSpec),
        modelSelection: { provider: 'fixture', model: 'fixture' },
      })
      owner.effect(() => () => runtime!.close())
      await runtime.start()
    } },
  })
  try {
    await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/scheduled-agent.cordis.yml', import.meta.url).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const delivery = { messageId: 'one', requestId: 'request', botId: 'bot', chatType: 'single' as const, userId: 'user', target: 'user', text: '', frame: {} }
    const { sessionId } = conversationIdentity('bot', 'identity', 'shared', delivery)
    return { ctx, root, client, sessionId, get runtime() { return runtime! },
      close: async (remove = true) => { await ctx.fiber.dispose(); if (remove) await rm(root, { recursive: true, force: true }) },
    }
  } catch (error: unknown) {
    await ctx.fiber.dispose()
    if (options.root === undefined) await rm(root, { recursive: true, force: true })
    throw error
  }
}
