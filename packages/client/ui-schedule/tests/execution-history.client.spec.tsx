// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate, RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { ScheduleExecution, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ExecutionHistory, type ExecutionHistoryInjected } from '../src/client/ExecutionHistory.tsx'
import { en, zh } from '../src/client/task-manager-locales.ts'

type Result = Awaited<ReturnType<ExecutionHistoryInjected['loadExecutions']>>
const id = 'automatic-task' as ScheduleId
const sessionId = 'original-session' as SessionId
function execution(status: ScheduleExecution['status']): ScheduleExecution {
  return {
    id: `execution-${status}` as ScheduleExecution['id'], inputMessageId: `input-${status}` as ScheduleExecution['inputMessageId'], providerId: 'host', scheduleId: id, sessionId,
    title: 'Inspect metrics', prompt: 'Inspect metrics', scheduledAt: '2026-10-13T15:40:00.000Z',
    createdAt: '2026-10-13T15:40:01.000Z', status,
  }
}
function mount(dictionary: typeof en | typeof zh = en) {
  const records: ScheduleExecution[] = [
    execution('queued'), execution('running'), { ...execution('completed'), output: '<img src=x>\nAll checked.' },
    execution('failed'), { ...execution('interrupted'), interruptionReason: 'crash' },
  ]
  const loadExecutions = vi.fn<ExecutionHistoryInjected['loadExecutions']>().mockResolvedValue({ ok: true, value: records })
  const props = { id, sessionId, revision: 1, timeZone: 'UTC', loadExecutions, t: makeTranslate(dictionary) }
  const view = render(<ExecutionHistory {...props} />)
  return { props, view, loadExecutions }
}
afterEach(cleanup)

describe.each([en, zh])('Agent execution records', (dictionary) => {
  it('shows persisted states and escaped output without treating delivery as completion', async () => {
    const h = mount(dictionary)
    expect(screen.getByRole('status', { name: dictionary['execution.loading'] }).textContent).toBe('')
    await screen.findAllByRole('region', { name: dictionary['execution.label'] })
    expect(h.loadExecutions).toHaveBeenCalledExactlyOnceWith({ id, sessionId, limit: 100 })
    for (const status of ['queued', 'running', 'completed', 'failed', 'interrupted'] as const) {
      expect(screen.getByText(dictionary[`execution.status.${status}`])).toBeTruthy()
    }
    expect(screen.getByText(dictionary['execution.reason.crash'])).toBeTruthy()
    fireEvent.click(screen.getByText(dictionary['execution.output']))
    expect(screen.getByText('<img src=x> All checked.')).toBeTruthy()
    expect(h.view.container.querySelector('img')).toBeNull()
    expect(h.view.container.textContent).not.toContain(dictionary['delivery.label'])
    const visible = screen.getAllByRole('region', { name: dictionary['execution.label'] })
      .map(region => region.textContent)
    expect(visible).toMatchSnapshot()
  })

  it('retains records during a failed refresh and retries without private error detail', async () => {
    const h = mount(dictionary)
    await screen.findAllByRole('region', { name: dictionary['execution.label'] })
    h.loadExecutions.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'Private detail', {}) })
    fireEvent.click(screen.getByRole('button', { name: dictionary['delivery.refresh'] }))
    await screen.findByRole('alert')
    expect(screen.getAllByRole('region', { name: dictionary['execution.label'] })).toHaveLength(5)
    expect(h.view.container.textContent).not.toContain('Private detail')
    fireEvent.click(screen.getByRole('button', { name: dictionary['delivery.retry'] }))
    await act(async () => {})
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

it('ignores superseded and unmounted reads after execution status changes', async () => {
  const older = Promise.withResolvers<Result>()
  const newer = Promise.withResolvers<Result>()
  const h = mount()
  await screen.findAllByRole('region', { name: en['execution.label'] })
  h.loadExecutions.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
  h.view.rerender(<ExecutionHistory {...h.props} revision={2} />)
  h.view.rerender(<ExecutionHistory {...h.props} revision={3} />)
  await act(async () => { newer.resolve({ ok: true, value: [execution('completed')] }); await newer.promise })
  await act(async () => { older.resolve({ ok: true, value: [execution('running')] }); await older.promise })
  expect(screen.queryByText(en['execution.status.running'])).toBeNull()
  expect(screen.getByText(en['execution.status.completed'])).toBeTruthy()
  const final = Promise.withResolvers<Result>()
  h.loadExecutions.mockReturnValueOnce(final.promise)
  h.view.rerender(<ExecutionHistory {...h.props} revision={4} />)
  h.view.unmount()
  await act(async () => { final.resolve({ ok: true, value: [execution('failed')] }); await final.promise })
  expect(screen.queryByText(en['execution.status.failed'])).toBeNull()
})

it('shows empty history and handles a rejected first read with retry', async () => {
  const loadExecutions = vi.fn<ExecutionHistoryInjected['loadExecutions']>()
    .mockRejectedValueOnce(new Error('Private transport detail')).mockResolvedValue({ ok: true, value: [] })
  render(<ExecutionHistory id={id} sessionId={sessionId} revision={1} loadExecutions={loadExecutions} t={makeTranslate(en)} />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: en['delivery.retry'] }))
  await screen.findByText(en['execution.empty'])
})
