import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type RevisionHeader } from '@case-desk/domain'

import { countdownText, deadlineText } from './zoned'

// NOTE: How the report and the publishing screens show review rounds (D11,
// D18): each revision with its status, the deadline in its own time zone and,
// for the open round, a countdown. Pure: the time now is a parameter, read by
// the screen's clock Command.

export const statusText = (revision: RevisionHeader): string =>
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
        [h.Class('text-lg text-msf-grey')],
        ['No revision has been published.'],
      ),
    onNonEmpty: list =>
      h.ul(
        [
          h.AriaLabel('Revisions'),
          h.Class(
            'flex flex-col divide-y divide-msf-line border-y border-msf-line',
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
                [h.Class('text-lg font-bold text-msf-black')],
                [`${revision.label}, from Draft ${revision.draft}`],
              ),
              h.p([h.Class('text-base text-msf-ink')], [statusText(revision)]),
              h.p(
                [h.Class('text-base text-msf-grey')],
                [roundLine(revision, nowMs)],
              ),
            ],
          ),
        ),
      ),
  })
