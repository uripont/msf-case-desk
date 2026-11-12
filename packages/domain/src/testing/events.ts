import { Result } from 'effect'

import { latestRound } from '../report-flow'
import type { ReportEvent } from '../round-events'
import { AUTHOR_IDS, type Run } from './reports'

// NOTE: Test support: the event log a stage 2 server would have written for a
// generated run of the report lifecycle. Every successful event leaves its
// facts: a shared draft, a published revision with everyone told at once, a
// review (with comments on every second one). Times are the run's own.
export const eventsFromRun = (run: Run): ReadonlyArray<ReportEvent> => {
  const out: Array<ReportEvent> = []
  let reviews = 0
  for (const step of run.steps) {
    if (!Result.isSuccess(step.result)) continue
    const after = step.result.success
    const { event, now } = step
    if (event.type === 'share_draft') {
      out.push({
        type: 'draft_shared',
        draft: after.draftCount,
        accountId: AUTHOR_IDS[0] ?? 'author-1',
        at: now,
      })
    } else if (
      event.type === 'publish_revision' ||
      event.type === 'publish_closing_revision'
    ) {
      const round = latestRound(after)
      if (round === undefined) continue
      out.push({
        type: 'revision_published',
        revision: round.revision,
        at: now,
      })
      for (const person of round.participants) {
        out.push({
          type: 'notified',
          revision: round.revision,
          accountId: person.accountId,
          at: now,
        })
      }
    } else if (event.type === 'submit_review') {
      const round = step.settledBefore.rounds.find(r => r.status === 'open')
      if (round === undefined) continue
      reviews += 1
      out.push({
        type: 'review',
        id: `review-${reviews}`,
        reviewerId: event.reviewerId,
        revision: round.revision,
        decision: event.decision,
        hasComments: reviews % 2 === 0,
        at: now,
      })
    }
  }
  return out
}
