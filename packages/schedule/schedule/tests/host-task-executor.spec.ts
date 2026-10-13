/** Host scheduled inputs settle against real loop events and durable Session flushes. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { hostTaskExecutor } from '../src/task-executor.ts'
import { ScheduleId } from '../src/domain.ts'
import type { ScheduleExecution, ScheduleExecutionId } from '../src/types.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function setup(adapter: MockAdapter) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-host-'))
  cleanups.push(async () => { await rm(root, { recursive: true, force: true }) })
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  const agent = await ctx.agentLoop.create(SessionId('scheduled-host'), { provider: 'mock', model: 'mock' })
  ctx.provide('sessionController', { resolveAgent: async () => ({ agent }) } as never)
  const now = new Date().toISOString()
  const execution: ScheduleExecution = { id: 'host-execution' as ScheduleExecutionId, inputMessageId: MessageId('host-input'),
    providerId: 'host', scheduleId: ScheduleId('host-task'), sessionId: agent.session.id,
    title: 'Check', prompt: 'Read state', status: 'running', createdAt: now, scheduledAt: now }
  return { ctx, agent, execution, executor: hostTaskExecutor(ctx) }
}

describe('Host scheduled execution lifecycle', () => {
  it('keeps the settled turn output identities while a later human turn runs during output flush', async () => {
    const adapter = new MockAdapter([textResponse('Scheduled result'), textResponse('Human result')])
    const { ctx, agent, execution, executor } = await setup(adapter)
    const scheduledIds: MessageId[] = []
    const human = Promise.withResolvers<undefined>()
    const scheduled = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let scheduledEnded = false
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session) return
      if (event.type === 'assistant/message' && !scheduledEnded) scheduledIds.push(event.data.message.id)
      if (event.type === 'turn/end' && event.data.turn === 1) {
        scheduledEnded = true
        scheduled.resolve(undefined)
      }
      if (event.type === 'turn/end' && event.data.turn === 2) human.resolve(undefined)
    }, { global: true })
    ctx.on('session/flush', async (session) => { if (session === agent.session && scheduledEnded) await release.promise })
    const running = executor.execute(execution, new AbortController().signal)
    try {
      await scheduled.promise
      await agent.whenIdle()
      agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Human follow-up' }] }))
      await human.promise
    } finally { release.resolve(undefined) }
    const outcome = await running
    expect(outcome).toMatchObject({ status: 'completed', inputMessageId: execution.inputMessageId, messageIds: scheduledIds, output: 'Scheduled result' })
    expect(scheduledIds).toHaveLength(1)
    const reader = await ctx.sessionPersistence.open(agent.session.id, 'read')
    try {
      const events = (await reader.read()).events
      expect(events.filter(event => event.type === 'user/message' && event.data.id === execution.inputMessageId)).toHaveLength(1)
      expect(events.filter(event => event.type === 'assistant/message').map(event => event.data.message.id)).toEqual(expect.arrayContaining(scheduledIds))
    } finally { await reader.close() }
  })

  it('reports interruption when a real pre-step listener rejects the claimed scheduled input', async () => {
    const adapter = new MockAdapter([])
    const { ctx, execution, executor } = await setup(adapter)
    ctx.on('agent/pre-step', async (_payload, next) => { await next(); return { kind: 'enter', messages: [] } }, { global: true })
    await expect(executor.execute(execution, new AbortController().signal)).resolves.toMatchObject({ status: 'interrupted', inputMessageId: execution.inputMessageId, error: 'Task input was not admitted to a model request.' })
    expect(adapter.requests).toHaveLength(0)
  })

  it('awaits cancellation of its own admitted turn without leaving the loop running', async () => {
    const entered = Promise.withResolvers<undefined>()
    const adapter = new MockAdapter([textResponse('Should not run')])
    const { ctx, agent, execution, executor } = await setup(adapter)
    const barrier = Promise.withResolvers<undefined>()
    ctx.on('agent/request', async (_payload, next) => { entered.resolve(undefined); await barrier.promise; return await next() }, { global: true })
    const controller = new AbortController()
    const running = executor.execute(execution, controller.signal)
    try {
      await entered.promise
      controller.abort(new Error('Host unloaded'))
    } finally { barrier.resolve(undefined) }
    await expect(running).resolves.toMatchObject({ status: 'interrupted', inputMessageId: execution.inputMessageId })
    await agent.whenIdle()
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(adapter.requests).toHaveLength(0)
  })
})
