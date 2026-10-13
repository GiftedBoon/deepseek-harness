/** Durable Agent execution results, separate from reminder inbox acknowledgments. */
import { useEffect, useState } from 'react'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, IconClockOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ScheduleExecution, ScheduleId } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatScheduleNextRun } from './schedule-format.ts'
import css from './TaskManagerPage.module.css'

/** Read bounded execution results without activating their Session. */
export interface ExecutionHistoryInjected {
  /**
   * Read the newest executions for the original task and Session.
   * @param request - Exact task binding and maximum number of records.
   * @returns Durable execution facts, or a Remote failure.
   */
  readonly loadExecutions: (request: { sessionId: SessionId; id: ScheduleId; limit: number }) => Promise<RemoteResult<ScheduleExecution[]>>
}

type Props = ExecutionHistoryInjected & PropsLocale<'schedule.manager'> & {
  readonly id: ScheduleId
  readonly sessionId: SessionId
  readonly revision: number
  readonly timeZone?: string | undefined
}

/**
 * Render execution state, output, and interruption reason; refresh failures retain loaded records.
 * @param props - Original task binding, catalog revision, query action, and locale.
 * @returns Bounded execution history with loading, retry, and refresh actions.
 */
export function ExecutionHistory({ id, sessionId, revision, timeZone, loadExecutions, t }: Props) {
  const [records, setRecords] = useState<ScheduleExecution[]>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let current = true
    setLoading(true)
    setFailed(false)
    const load = async (): Promise<void> => {
      try {
        const result = await loadExecutions({ id, sessionId, limit: 100 })
        if (!current) return
        if (result.ok) setRecords(result.value)
        else setFailed(true)
      } catch (_error: unknown) {
        // Transport exceptions share the localized retry state and retain records.
        if (current) setFailed(true)
      } finally {
        if (current) setLoading(false)
      }
    }
    void load()
    return () => { current = false }
  }, [id, sessionId, revision, refresh, loadExecutions])
  const populated = records !== undefined && records.length > 0
  return <div className={css.deliveryHistory} aria-busy={loading}>
    <div className={css.detailScroll}>
      {loading && !populated && <div className={css.empty} role="status" aria-label={t('execution.loading')}>
        <StateDot state="ongoing" />
      </div>}
      {failed && <div className={populated ? css.notice : css.empty}>
        <p role="alert">{t('execution.error')}</p>
        <Button variant="outline" size="sm" onClick={() => { setRefresh(value => value + 1) }}>{t('delivery.retry')}</Button>
      </div>}
      {!loading && !failed && records?.length === 0 && <div className={css.empty} role="status">
        <IconClockOutlineRegular size={24} className={css.emptyGlyph} />
        <h3>{t('execution.empty')}</h3>
      </div>}
      {records?.map(record => <section key={record.id} className={css.delivery} aria-label={t('execution.label')}>
        <IconClockOutlineRegular className={css.deliveryGlyph} />
        <div className={css.deliveryBody}>
          <div className={css.deliveryHead}>
            <time className={css.deliveryTime} dateTime={record.scheduledAt}>
              {formatScheduleNextRun(record.scheduledAt, t('time.locale'), timeZone)}
            </time>
          </div>
          <p className={css.readonlyPrompt}>{t(`execution.status.${record.status}`)}</p>
          {record.interruptionReason !== undefined && <p className={css.readonlyPrompt}>{t(`execution.reason.${record.interruptionReason}`)}</p>}
          {record.output !== undefined && <details>
            <summary>{t('execution.output')}</summary>
            <p className={css.readonlyPrompt}>{record.output}</p>
          </details>}
        </div>
      </section>)}
      {populated && <>
        <p className={css.readonlyPrompt}>{t('execution.limit', { count: records.length })}</p>
        <Button variant="outline" disabled={loading} onClick={() => { setRefresh(value => value + 1) }}>{t('delivery.refresh')}</Button>
      </>}
    </div>
  </div>
}
