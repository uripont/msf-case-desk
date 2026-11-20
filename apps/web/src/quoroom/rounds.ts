import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type RevisionHeader } from '@quoroom/domain'

import { countdownText, deadlineText } from './zoned'

// NOTE: How the report and the publishing screens show review rounds (D11,
// D18): each revision with its status, the deadline in its own time zone and,
// for the open round, a countdown. Pure: the time now is a parameter, read by
// the screen's clock Command.

export const statusText = (revision: {
  number: number
  status: RevisionHeader['status']
  decidedBy?: RevisionHeader['decidedBy'] | undefined
  replacedBy?: number | undefined
}): string =>
  revision.status === 'open'
    ? 'Open for review'
    : revision.status === 'superseded'
      ? `Superseded by Revision ${revision.replacedBy ?? revision.number + 1}`
      : revision.decidedBy === 'deadline'
        ? 'Decided at the deadline'
        : 'Decided, the approval rule was met'

export const currentRoundOf = (
  revisions: ReadonlyArray<RevisionHeader>,
): Option.Option<RevisionHeader> =>
  Array.findLast(revisions, revision => revision.status === 'open')

export const latestRevisionOf = (
  revisions: ReadonlyArray<RevisionHeader>,
): Option.Option<RevisionHeader> => Array.last(revisions)

export const dueText = (revision: RevisionHeader): string =>
  `Due ${deadlineText(revision.deadline.at, revision.deadline.timeZone)}`

export const roundLine = (revision: RevisionHeader, nowMs: number): string =>
  revision.status === 'open'
    ? `${dueText(revision)}. ${countdownText(revision.deadline.at, nowMs)}.`
    : dueText(revision)

export const revisionsList = <M>(
  h: HtmlBuilder<M>,
  revisions: ReadonlyArray<RevisionHeader>,
  nowMs: number,
): Html =>
  Array.match(revisions, {
    onEmpty: () =>
      h.p(
        [h.Class('text-lg text-brand-grey')],
        ['No revision has been published.'],
      ),
    onNonEmpty: list =>
      h.ul(
        [
          h.AriaLabel('Revisions'),
          h.Class(
            'flex flex-col divide-y divide-brand-line border-y border-brand-line',
          ),
        ],
        Array.map(Array.reverse(list), revision =>
          h.keyed('li')(
            String(revision.number),
            [
              h.Class('flex flex-col gap-1 py-3'),
              h.DataAttribute('revision', String(revision.number)),
              h.DataAttribute('status', revision.status),
            ],
            [
              h.p(
                [h.Class('text-lg font-bold text-brand-ink')],
                [`${revision.label}, from Draft ${revision.draft}`],
              ),
              h.p([h.Class('text-base text-brand-ink')], [statusText(revision)]),
              h.p(
                [h.Class('text-base text-brand-grey')],
                [roundLine(revision, nowMs)],
              ),
            ],
          ),
        ),
      ),
  })

export const decisionText = (
  decision: 'approve' | 'request_changes' | 'comment',
): string =>
  decision === 'approve'
    ? 'Approved'
    : decision === 'request_changes'
      ? 'Asked for changes'
      : 'Commented only'

// NOTE: The reviewer's own time zone, read in a Command (the browser knows it;
// the domain never does), and the zone of a deadline when the author's zone
// is the same one.
export const zoneNote = (authorZone: string, ownZone: string): string =>
  authorZone === ownZone ? '' : ` (set in ${authorZone.replaceAll('_', ' ')})`
