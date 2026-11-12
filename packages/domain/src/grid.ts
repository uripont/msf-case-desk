import { type ReviewDecision, type RoundTally, tallyRound } from './approval'
import type { DecidedBy, ReportFlow, RoundStatus } from './report-flow'
import { draftLabel, revisionTitle } from './report-numbering'
import {
  type ReminderKind,
  type ReportEvent,
  decidedAtOf,
  eventsOfType,
  publishedAtOf,
  reviewFactsOf,
} from './round-events'
import { type Template } from './template'

// NOTE: The status grid (pipeline step 10), a pure projection of the report's
// flow and its event log. Computed on request, never stored.
//
// Rows are shared drafts and revisions. Columns are people: the authors for a
// draft, the participants of the round for a revision. Every fact carries its
// time. A fact that is not known is absent, never a made-up time: "read" is
// known only if the reader opened the revision in the app.
//
// - A draft cell: whether that author shared the draft, and when they read it.
// - A revision cell: told (`sent`), opened (`read`), WhatsApp opened by an
//   author for that reviewer (D17), every review with its decision and time,
//   the standing decision (the latest approve or request changes), and the
//   reminders. A reviewer removed from the round keeps their cell, marked
//   `removed`.
// - A revision row: the deadline, the rule status per voting role (what the
//   flow's tally says), how the round was decided (by its rule or by its
//   deadline) and when, and which revision replaced it.
//
// The reviews of a cell come from the event log; the rule status comes from the
// flow. The two agree when the log is complete.

export type Fact = Readonly<{ at: number }>

export type DecisionFact = Readonly<{ decision: ReviewDecision; at: number }>

export type ReviewCell = Readonly<{
  id: string
  decision: ReviewDecision
  hasComments: boolean
  at: number
  // NOTE: true for the review that holds the reviewer's standing decision.
  standing: boolean
}>

export type RevisionCell = Readonly<{
  accountId: string
  roleId: string
  roleName: string
  removed: boolean
  sent: Fact | undefined
  read: Fact | undefined
  whatsappOpened: Fact | undefined
  reviews: ReadonlyArray<ReviewCell>
  decision: DecisionFact | undefined
  reminders: ReadonlyArray<Readonly<{ kind: ReminderKind; at: number }>>
}>

export type RevisionRow = Readonly<{
  kind: 'revision'
  revision: number
  label: string
  draft: number
  closing: boolean
  publishedAt: number | undefined
  deadline: number
  status: RoundStatus
  decidedBy: DecidedBy | undefined
  decidedAt: number | undefined
  replacedBy: number | undefined
  rule: RoundTally
  cells: ReadonlyArray<RevisionCell>
}>

export type DraftCell = Readonly<{
  accountId: string
  shared: Fact | undefined
  read: Fact | undefined
}>

export type DraftRow = Readonly<{
  kind: 'draft'
  draft: number
  label: string
  sharedBy: string | undefined
  sharedAt: number | undefined
  cells: ReadonlyArray<DraftCell>
}>

export type Grid = Readonly<{
  authors: ReadonlyArray<string>
  drafts: ReadonlyArray<DraftRow>
  revisions: ReadonlyArray<RevisionRow>
}>

export type GridInput = Readonly<{
  template: Template
  flow: ReportFlow
  authors: ReadonlyArray<string>
  events: ReadonlyArray<ReportEvent>
}>

const factOf = (
  events: ReadonlyArray<{ accountId: string; at: number }>,
  accountId: string,
): Fact | undefined => {
  const times = events.filter(e => e.accountId === accountId).map(e => e.at)
  return times.length === 0 ? undefined : { at: Math.min(...times) }
}

const draftRows = (input: GridInput): ReadonlyArray<DraftRow> => {
  const shares = eventsOfType(input.events, 'draft_shared')
  const reads = eventsOfType(input.events, 'draft_read')
  return Array.from({ length: input.flow.draftCount + 1 }, (_, draft) => {
    const shared = shares.find(event => event.draft === draft)
    const sharedReads = reads.filter(event => event.draft === draft)
    return {
      kind: 'draft' as const,
      draft,
      label: draftLabel(draft),
      sharedBy: shared?.accountId,
      sharedAt: shared?.at,
      cells: input.authors.map((accountId): DraftCell => ({
        accountId,
        shared:
          shared !== undefined && shared.accountId === accountId
            ? { at: shared.at }
            : undefined,
        read: factOf(sharedReads, accountId),
      })),
    }
  })
}

const revisionRows = (input: GridInput): ReadonlyArray<RevisionRow> => {
  const { template, flow, events } = input
  const notified = eventsOfType(events, 'notified')
  const read = eventsOfType(events, 'read')
  const whatsapp = eventsOfType(events, 'whatsapp_opened')
  const reminded = eventsOfType(events, 'reminded')
  return flow.rounds.map((round, index): RevisionRow => {
    const reviews = reviewFactsOf(events, round.revision)
    const standingId = new Map<string, string>()
    const standingFact = new Map<string, DecisionFact>()
    for (const review of reviews) {
      if (review.decision === 'comment') continue
      standingId.set(review.reviewerId, review.id)
      standingFact.set(review.reviewerId, {
        decision: review.decision,
        at: review.at,
      })
    }
    const people = [
      ...round.participants.map(p => ({ ...p, removed: false })),
      ...round.removed.map(p => ({ ...p, removed: true })),
    ]
    const cells = people.map((person): RevisionCell => {
      const mine = <T extends { revision: number; accountId: string }>(
        list: ReadonlyArray<T>,
      ): ReadonlyArray<T> =>
        list.filter(
          e =>
            e.revision === round.revision && e.accountId === person.accountId,
        )
      return {
        accountId: person.accountId,
        roleId: person.roleId,
        roleName:
          template.roles.find(role => role.id === person.roleId)?.name ??
          person.roleId,
        removed: person.removed,
        sent: factOf(mine(notified), person.accountId),
        read: factOf(mine(read), person.accountId),
        whatsappOpened: factOf(mine(whatsapp), person.accountId),
        reviews: reviews
          .filter(review => review.reviewerId === person.accountId)
          .map(review => ({
            id: review.id,
            decision: review.decision,
            hasComments: review.hasComments,
            at: review.at,
            standing: standingId.get(person.accountId) === review.id,
          })),
        decision: standingFact.get(person.accountId),
        reminders: mine(reminded)
          .map(e => ({ kind: e.kind, at: e.at }))
          .sort((a, b) => a.at - b.at),
      }
    })
    const next = flow.rounds[index + 1]
    return {
      kind: 'revision',
      revision: round.revision,
      label: revisionTitle(round.revision, round.closing),
      draft: round.draft,
      closing: round.closing,
      publishedAt: publishedAtOf(events, round.revision),
      deadline: round.deadline,
      status: round.status,
      decidedBy: round.decidedBy,
      decidedAt: decidedAtOf(events, round),
      replacedBy: round.status === 'superseded' ? next?.revision : undefined,
      rule: tallyRound(template, round),
      cells,
    }
  })
}

export const buildGrid = (input: GridInput): Grid => ({
  authors: input.authors,
  drafts: draftRows(input),
  revisions: revisionRows(input),
})
