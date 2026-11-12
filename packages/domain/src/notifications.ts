import { standingDecisions } from './approval'
import { type ReportFlow, type Round, openRound } from './report-flow'
import {
  type ReportEvent,
  decidedAtOf,
  eventsOfType,
  publishedAtOf,
} from './round-events'
import { type Template } from './template'

// NOTE: Notification rules (D12, D17, D19) as a pure function
// `(state, now, config) -> jobs`. Time is the `now` argument; the timings are
// configuration, so tests and test environments use minutes.
//
// What the rules say, for the open round (only the latest round can be open):
// - every participant is sent the review request, once, at publication;
// - every participant of a voting role who has not decided is reminded, at the
//   first and the final offset before the deadline (default 48 h and 4 h);
//   a reminder whose time is not after publication is skipped (the request
//   covers it), none is ever due at or after the deadline, and none is made
//   once `now` has reached the deadline;
// - someone who has decided (approve or request changes; a comment-only review
//   is not a decision) is never reminded and no longer needs the request;
// - a `deadline` job (no recipient) is due at the deadline, to decide the round;
// - if the revision replaced an earlier one, the reviewers who were in the
//   earlier round and are in this one are told so.
// Nothing of the above is scheduled for a superseded or decided round.
//
// Authors (the drafting role, D19):
// - a review that came with comments, or asked for changes: always told;
// - an approval without comments: only the authors whose preference is on
//   (off by default);
// - a decided round: always told the outcome.
// These report something that happened, so they exist for every round, at the
// time it happened.
//
// Deduplication (D12): the key is `(round, recipient, kind, deadline)`. The
// deadline is part of the key for the kinds that are scheduled against it
// (the reminders and the `deadline` job), so extending a deadline writes new
// jobs and the old ones fail `isJobNeeded`. The other kinds do not depend on
// the deadline and carry none (`deadline: null`). A review, which can happen
// several times in a round, adds its ID as `subject`.
//
// `notificationJobs` returns only the jobs whose key is not in `existing`, so
// running it twice, with the first result added to `existing`, gives nothing.
//
// Reminders are never created late. A reminder whose time is not after `now`
// at the moment it would be written is skipped: after a deadline is extended
// the new first reminder may already lie in the past, and writing it would
// send it after a later reminder of the same round that was already sent.
// The skip is in `notificationJobs` only (the jobs to write), not in
// `desiredJobs` (the jobs the rules want), so a job written on time stays
// needed when the pass claims it later. Writing happens in the batch of the
// event (publishing, extending), so `now` is that event's time, and the
// result is a function of `(state, now, config)`: asking again with the first
// result in `existing` gives nothing, and asking later gives nothing new.

export const HOUR = 3_600_000
export const MINUTE = 60_000

export type NotificationConfig = Readonly<{
  // NOTE: Delay between publication and the review request.
  requestDelay: number
  firstReminderBefore: number
  finalReminderBefore: number
}>

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  requestDelay: 0,
  firstReminderBefore: 48 * HOUR,
  finalReminderBefore: 4 * HOUR,
}

// NOTE: Timings in minutes, for tests and test environments.
export const notificationConfigInMinutes = (
  firstReminderBefore: number,
  finalReminderBefore: number,
  requestDelay = 0,
): NotificationConfig => ({
  requestDelay: requestDelay * MINUTE,
  firstReminderBefore: firstReminderBefore * MINUTE,
  finalReminderBefore: finalReminderBefore * MINUTE,
})

export type NotificationKind =
  | 'review_request'
  | 'reminder_first'
  | 'reminder_final'
  | 'deadline'
  | 'revision_replaced'
  | 'review_received'
  | 'approval_received'
  | 'round_decided'

// NOTE: The kinds scheduled for the open round, none of which may exist for a
// superseded or decided round.
export const SCHEDULED_KINDS: ReadonlyArray<NotificationKind> = [
  'review_request',
  'reminder_first',
  'reminder_final',
  'deadline',
  'revision_replaced',
]

const REMINDER_KINDS: ReadonlyArray<NotificationKind> = [
  'reminder_first',
  'reminder_final',
]

export type NotificationChannel = 'inbox'

export type NotificationJob = Readonly<{
  key: string
  kind: NotificationKind
  // NOTE: `null` for the `deadline` job, which belongs to nobody.
  recipient: string | null
  revision: number
  dueAt: number
  deadline: number | null
  subject: string | null
  channel: NotificationChannel
}>

export type AuthorPreferences = Readonly<{
  accountId: string
  // NOTE: D19: told of each single approval. Off by default.
  notifyOnApproval: boolean
}>

export type NotificationState = Readonly<{
  template: Template
  flow: ReportFlow
  authors: ReadonlyArray<AuthorPreferences>
  events: ReadonlyArray<ReportEvent>
  // NOTE: Keys of the jobs that already exist, whatever their state.
  existing: ReadonlyArray<string>
}>

export const jobKey = (parts: {
  revision: number
  recipient: string | null
  kind: NotificationKind
  deadline: number | null
  subject?: string | null
}): string =>
  JSON.stringify([
    parts.revision,
    parts.recipient,
    parts.kind,
    parts.deadline,
    parts.subject ?? null,
  ])

const job = (
  kind: NotificationKind,
  round: Round,
  recipient: string | null,
  dueAt: number,
  options: { deadline?: boolean; subject?: string } = {},
): NotificationJob => {
  const deadline = options.deadline === true ? round.deadline : null
  const subject = options.subject ?? null
  return {
    key: jobKey({
      revision: round.revision,
      recipient,
      kind,
      deadline,
      subject,
    }),
    kind,
    recipient,
    revision: round.revision,
    dueAt,
    deadline,
    subject,
    channel: 'inbox',
  }
}

const votes = (template: Template, roleId: string): boolean =>
  template.roles
    .find(role => role.id === roleId)
    ?.permissions.includes('vote') ?? false

const openRoundJobs = (
  state: NotificationState,
  round: Round,
  index: number,
  now: number,
  config: NotificationConfig,
): ReadonlyArray<NotificationJob> => {
  const out: Array<NotificationJob> = [
    job('deadline', round, null, round.deadline, { deadline: true }),
  ]
  const published = publishedAtOf(state.events, round.revision)
  if (published === undefined || !(now < round.deadline)) return out
  const decided = new Set(
    standingDecisions(round.reviews, round.revision).keys(),
  )
  const before = state.flow.rounds[index - 1]
  const earlier = new Set(
    before?.status === 'superseded'
      ? [...before.participants, ...before.removed].map(p => p.accountId)
      : [],
  )
  const requestAt = published + config.requestDelay
  for (const participant of round.participants) {
    const id = participant.accountId
    if (decided.has(id)) continue
    if (requestAt < round.deadline) {
      out.push(job('review_request', round, id, requestAt))
      if (earlier.has(id)) {
        out.push(job('revision_replaced', round, id, requestAt))
      }
    }
    if (!votes(state.template, participant.roleId)) continue
    const reminders: ReadonlyArray<readonly [NotificationKind, number]> = [
      ['reminder_first', config.firstReminderBefore],
      ['reminder_final', config.finalReminderBefore],
    ]
    for (const [kind, offset] of reminders) {
      const dueAt = round.deadline - offset
      if (dueAt > published && dueAt < round.deadline) {
        out.push(job(kind, round, id, dueAt, { deadline: true }))
      }
    }
  }
  return out
}

const authorJobs = (
  state: NotificationState,
): ReadonlyArray<NotificationJob> => {
  const out: Array<NotificationJob> = []
  for (const review of eventsOfType(state.events, 'review')) {
    const round = state.flow.rounds.find(r => r.revision === review.revision)
    if (round === undefined) continue
    const significant =
      review.decision === 'request_changes' || review.hasComments
    for (const author of state.authors) {
      if (significant) {
        out.push(
          job('review_received', round, author.accountId, review.at, {
            subject: review.id,
          }),
        )
      } else if (review.decision === 'approve' && author.notifyOnApproval) {
        out.push(
          job('approval_received', round, author.accountId, review.at, {
            subject: review.id,
          }),
        )
      }
    }
  }
  for (const round of state.flow.rounds) {
    const at = decidedAtOf(state.events, round)
    if (round.status !== 'decided' || at === undefined) continue
    for (const author of state.authors) {
      out.push(job('round_decided', round, author.accountId, at))
    }
  }
  return out
}

// NOTE: Every job that should exist, whether it has been written or not, in
// the order it falls due.
export const desiredJobs = (
  state: NotificationState,
  now: number,
  config: NotificationConfig,
): ReadonlyArray<NotificationJob> => {
  const open = openRound(state.flow)
  const index = open === undefined ? -1 : state.flow.rounds.indexOf(open)
  const scheduled =
    open === undefined ? [] : openRoundJobs(state, open, index, now, config)
  const seen = new Set<string>()
  return [...scheduled, ...authorJobs(state)]
    .filter(entry => !seen.has(entry.key) && seen.add(entry.key))
    .sort((a, b) => a.dueAt - b.dueAt || (a.key < b.key ? -1 : 1))
}

// NOTE: The jobs to write now: the desired ones that do not exist yet.
export const notificationJobs = (
  state: NotificationState,
  now: number,
  config: NotificationConfig,
): ReadonlyArray<NotificationJob> => {
  const existing = new Set(state.existing)
  return desiredJobs(state, now, config).filter(
    entry =>
      !existing.has(entry.key) &&
      !(REMINDER_KINDS.includes(entry.kind) && !(entry.dueAt > now)),
  )
}

// NOTE: The recheck of the pass (stage 7): a claimed job is delivered only if
// the rules still want it. A reminder for someone who has since decided, a job
// of a round that was superseded or decided, and one for a deadline that was
// extended all fail.
export const isJobNeeded = (
  entry: Pick<NotificationJob, 'key'>,
  state: NotificationState,
  now: number,
  config: NotificationConfig,
): boolean => desiredJobs(state, now, config).some(j => j.key === entry.key)
