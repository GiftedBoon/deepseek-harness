/** Host Session executor correlates claimed input with its durable whole turn. */
import { createUserMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ScheduleExecutionOutcome, ScheduleTaskExecutor } from './types.ts'
import { renderTaskFraming } from './task-runtime.ts'

/**
 * Create the default Host adapter; channels override it by a persisted adapter id.
 * @param ctx - Session restore and event services.
 * @returns Authority-preserving Host executor.
 */
export function hostTaskExecutor(ctx: Context): ScheduleTaskExecutor {
  return {
    id: 'host', accepts: () => true,
    async execute(execution, signal): Promise<ScheduleExecutionOutcome> {
      const resolved = await ctx.sessionController.resolveAgent(execution.sessionId)
      if ('error' in resolved) throw resolved.error
      signal.throwIfAborted()
      const agent = resolved.agent
      if (agent.status !== 'idle') {
        let onAbort!: () => void
        const cancelled = new Promise<never>((_resolve, reject) => {
          onAbort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))) }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) onAbort()
        })
        try { await Promise.race([agent.whenIdle(), cancelled]) } finally { signal.removeEventListener('abort', onAbort) }
      }
      signal.throwIfAborted()
      if (execution.expiresAt !== undefined && Date.now() >= Date.parse(execution.expiresAt)) return { status: 'interrupted', interruptionReason: 'expired' }
      const message = Object.freeze({ ...createUserMessage({ content: [{ type: 'text', text: renderTaskFraming(execution) }], source: { kind: 'schedule' } }), id: execution.inputMessageId })
      let turn: number | undefined
      let observedTurn: number | undefined
      let inputEntered = false
      const messageIds: MessageId[] = []
      const outputText: string[] = []
      let finish!: (value: ScheduleExecutionOutcome) => void
      let settled = false
      let enqueued = false
      const ended = new Promise<ScheduleExecutionOutcome>((resolve) => { finish = (value) => { settled = true; resolve(value) } })
      const claim = ctx.on('agent/inbox/claimed', (payload) => {
        if (payload.agent !== agent || payload.message.id !== message.id) return
        turn = payload.turn
      }, { global: true })
      const events = ctx.on('session/event', (session, event) => {
        if (session !== agent.session) return
        if (event.type === 'turn/start') {
          observedTurn = event.data.turn
          inputEntered = false
          messageIds.splice(0)
          outputText.splice(0)
        }
        if (event.type === 'user/message' && event.data.id === message.id) inputEntered = true
        if (event.type === 'assistant/message' && observedTurn !== undefined) {
          messageIds.push(event.data.message.id)
          outputText.push(event.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''))
        }
        if (event.type !== 'turn/end' || event.data.turn !== turn) return
        if (!inputEntered) {
          finish({ status: 'interrupted', inputMessageId: message.id,
            ...(execution.expiresAt !== undefined && Date.now() >= Date.parse(execution.expiresAt) ? { interruptionReason: 'expired' } : {}),
            error: 'Task input was not admitted to a model request.' })
          return
        }
        const output = outputText.join('\n\n')
        finish({ status: event.data.reason.kind === 'completed' ? 'completed' : event.data.reason.kind === 'error' ? 'failed' : 'interrupted', inputMessageId: message.id, messageIds: [...messageIds], output,
          ...(event.data.reason.kind === 'completed' ? {} : { error: `Turn ended: ${event.data.reason.kind}` }) })
      }, { global: true })
      const idle = ctx.on('agent/status', (payload) => {
        if (payload.agent === agent && payload.status === 'idle' && turn === undefined && !agent.inbox.nextTurn.some(value => value.id === message.id)) finish({ status: 'interrupted', inputMessageId: message.id, error: 'Task input was not executed.' })
      }, { global: true })
      const disposed = ctx.on('agent/disposed', (payload) => {
        if (payload.agent === agent) finish({ status: 'interrupted', inputMessageId: message.id, error: 'Agent disposed before task settlement.' })
      })
      const abort = (): void => {
        if (settled) return
        if (agent.inbox.remove(message.id)) finish({ status: 'interrupted', interruptionReason: 'unloaded', inputMessageId: message.id, error: 'Task cancelled before its input was claimed.' })
        else if (turn !== undefined) agent.cancel({ kind: 'hook', reason: 'Scheduled executor unloaded' }, { keepInbox: true })
        else finish({ status: 'interrupted', inputMessageId: message.id, error: 'Task cancelled before input delivery.' })
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        agent.followup(message)
        enqueued = true
        if (!await ctx.sessions.flush(agent.session)) throw new Error('Session persistence did not acknowledge scheduled input')
        const result = await ended
        if (!await ctx.sessions.flush(agent.session)) throw new Error('Session persistence did not acknowledge scheduled output')
        return result
      } catch (error: unknown) {
        if (enqueued) { abort(); await ended }
        throw error
      } finally {
        signal.removeEventListener('abort', abort)
        idle(); disposed(); events(); claim()
      }
    },
  }
}
