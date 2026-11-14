import { type NotificationKind, MINUTE } from './notifications'

// NOTE: What a notification says and how delivery is retried, as pure data
// and functions (stage 7). The in-app inbox, the web app and the channel for
// WhatsApp (stage 11) all read this one table, so the words of D12 and D19
// are written once.
//
// Messages never name the case or the report and never carry report text
// (D17): a kind, the deadline in its own time zone where there is one, and a
// link into the app.

// NOTE: What a channel reports about a message. `sent` and `delivered` are
// what a provider such as Meta calls back with; `failed` is a final failure.
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'

export type MessageTemplate = Readonly<{
  // NOTE: The name of the approved template at a provider (Meta). Without a
  // provider it only labels the message.
  name: string
  // NOTE: The parameters of the template, in order.
  parameters: ReadonlyArray<'deadline'>
}>

// NOTE: Every kind that has a recipient. `deadline` belongs to nobody: it only
// makes the pass decide the round.
export type MessageKind = Exclude<NotificationKind, 'deadline'>

export const MESSAGE_TEMPLATES: Readonly<Record<MessageKind, MessageTemplate>> = {
  review_request: { name: 'quoroom_review_request', parameters: ['deadline'] },
  reminder_first: { name: 'quoroom_reminder', parameters: ['deadline'] },
  reminder_final: { name: 'quoroom_reminder_final', parameters: ['deadline'] },
  revision_replaced: {
    name: 'quoroom_revision_replaced',
    parameters: ['deadline'],
  },
  review_received: { name: 'quoroom_review_received', parameters: [] },
  approval_received: { name: 'quoroom_approval_received', parameters: [] },
  round_decided: { name: 'quoroom_round_decided', parameters: [] },
  removed_from_round: { name: 'quoroom_removed_from_round', parameters: [] },
}

// NOTE: The line of the in-app inbox for each kind. The deadline, when the
// kind has one, is added by the reader in their own time zone.
export const IN_APP_TEXT: Readonly<Record<MessageKind, string>> = {
  review_request: 'A report is waiting for your review.',
  reminder_first: 'Reminder: a report is still waiting for your review.',
  reminder_final: 'Last reminder: a report is still waiting for your review.',
  revision_replaced:
    'A new revision replaced the one you were reviewing. It is waiting for your review.',
  review_received: 'A review with comments or a change request arrived.',
  approval_received: 'A reviewer approved the revision.',
  round_decided: 'The review round is decided.',
  removed_from_round: 'You were removed from a review round.',
}

export const isMessageKind = (kind: NotificationKind): kind is MessageKind =>
  kind !== 'deadline'

// NOTE: Where the recipient goes: a reviewer to the revision they were asked
// to review (also when it was replaced, so they can read why), an author to
// the screen that shows what happened. A reviewer who was removed no longer
// reads that revision, so they go to their list.
export const notificationLink = (
  kind: MessageKind,
  reportId: string,
  revision: number,
): string => {
  const report = `/r/${encodeURIComponent(reportId)}`
  switch (kind) {
    case 'review_request':
    case 'reminder_first':
    case 'reminder_final':
    case 'revision_replaced':
      return `${report}/rev/${revision}`
    case 'review_received':
      return `${report}/comments`
    case 'approval_received':
      return `${report}/grid`
    case 'round_decided':
      return report
    case 'removed_from_round':
      return '/inbox'
  }
}

// NOTE: What a channel is given to send. The recipient's own contact details
// are the channel's business and are never in it.
export type OutgoingMessage = Readonly<{
  // NOTE: The job's deduplication key with its report, stable across retries,
  // so a provider that supports idempotency can use it.
  idempotencyKey: string
  jobId: number
  kind: MessageKind
  recipientId: string
  template: MessageTemplate
  // NOTE: One text per entry of `template.parameters`.
  parameters: ReadonlyArray<string>
  // NOTE: A path inside the app; the channel puts the app's address before it.
  link: string
  // NOTE: 1 on the first try.
  attempt: number
}>

// ---- Retry ----------------------------------------------------------------------------------

// NOTE: A job is tried at most this many times: only a failure of the channel
// counts (`attempts`). After that it is a final failure.
export const MAX_ATTEMPTS = 5

// NOTE: A pass that was stopped halfway (its lease ran out and another pass
// took the job over), or a storage error while it was handled, is not the
// job's fault and does not count as an attempt. It counts as a deferral, with
// a larger cap; at the cap the job is a final failure and the pass logs an
// error, so a job that keeps killing its pass is noticed, not retried forever.
export const MAX_DEFERRALS = 50

// NOTE: A claim holds a job this long. A pass that stops halfway leaves its
// jobs claimed; once the lease has run out another pass takes them.
export const LEASE_MS = 2 * MINUTE

// NOTE: One minute after the first failure, doubling, at most 15 minutes.
export const retryDelay = (attempts: number): number =>
  Math.min(15, 2 ** Math.max(0, attempts - 1)) * MINUTE

// NOTE: When a job that was deferred for the `deferrals`-th time (counting
// this one) is tried again.
export const deferredAt = (now: number, deferrals: number): number =>
  now + retryDelay(deferrals)

// NOTE: When a job that has just failed for the `attempts`-th time is tried
// again, or `null` when it has used its attempts.
export const retryAt = (now: number, attempts: number): number | null =>
  attempts >= MAX_ATTEMPTS ? null : now + retryDelay(attempts)
