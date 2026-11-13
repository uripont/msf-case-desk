import { Option } from 'effect'

import {
  INTAKE_TEMPLATE,
  type PublishChoices,
  type RevisionHeader,
  type RoundView,
  type WhatsAppLink,
} from '@case-desk/domain'

import * as Publish from './quoroom/publish'
import { REPORT_ID, detailOf } from './report.fixtures'

// NOTE: Synthetic data for the publishing screen: a unit with one committee
// of two reviewers and a third registered reviewer, the intake template whose
// reviewing role (`committee`) reads the redacted text and needs everyone to
// approve. No real names or numbers.

export const NOW = Date.UTC(2026, 10, 13, 9, 0)

export const SCOPE = { reportId: REPORT_ID, generation: 1 }

export const CHOICES: typeof PublishChoices.Type = {
  latestDraft: 2,
  hasUnsharedChanges: false,
  redactionConfirmed: true,
  closingRequired: false,
  roles: [
    {
      roleId: 'committee',
      name: 'Committee',
      view: 'redacted',
      votes: true,
      comments: true,
      rule: { kind: 'all' },
    },
  ],
  committees: [
    {
      id: 'committee-1',
      name: 'Ethics committee',
      members: [
        { id: 'reviewer-1', name: 'Reviewer One' },
        { id: 'reviewer-2', name: 'Reviewer Two' },
      ],
    },
  ],
  reviewers: [
    { id: 'reviewer-1', name: 'Reviewer One' },
    { id: 'reviewer-2', name: 'Reviewer Two' },
    { id: 'reviewer-3', name: 'Reviewer Three' },
  ],
}

export const revision = (
  number: number,
  status: RevisionHeader['status'],
  replacedBy?: number,
): RevisionHeader => ({
  number,
  label: `Revision ${number}`,
  draft: number,
  closing: false,
  publishedAt: NOW - 86_400_000,
  deadline: {
    at: NOW + 3 * 86_400_000 + 4 * 3_600_000,
    timeZone: 'Europe/Madrid',
  },
  status,
  ...(replacedBy === undefined ? {} : { replacedBy }),
})

export const ROUND: typeof RoundView.Type = {
  revision: 2,
  draft: 2,
  closing: false,
  status: 'open',
  deadline: revision(2, 'open').deadline,
  participants: [
    {
      accountId: 'reviewer-1',
      name: 'Reviewer One',
      roleId: 'committee',
      roleName: 'Committee',
      removed: false,
    },
    {
      accountId: 'reviewer-2',
      name: 'Reviewer Two',
      roleId: 'committee',
      roleName: 'Committee',
      removed: false,
    },
  ],
  tally: {
    met: false,
    roles: [
      {
        roleId: 'committee',
        rule: { kind: 'all' },
        voters: 2,
        approvals: 0,
        changesRequested: 0,
        met: false,
      },
    ],
  },
}

export const LINK: typeof WhatsAppLink.Type = {
  accountId: 'reviewer-1',
  name: 'Reviewer One',
  number: '34600000001',
  text: 'A report is waiting for your review in Quoroom, due 16 Nov, 14:00 Madrid time. https://desk.test/',
  url: 'https://wa.me/34600000001?text=A%20report%20is%20waiting%20for%20your%20review%20in%20Quoroom%2C%20due%2016%20Nov%2C%2014%3A00%20Madrid%20time.%20https%3A%2F%2Fdesk.test%2F',
}

export const loaded = (
  options: Readonly<{
    choices?: typeof PublishChoices.Type
    revisions?: ReadonlyArray<RevisionHeader>
    round?: typeof RoundView.Type
    whatsapp?: Publish.LoadedPublish['whatsapp']
  }> = {},
): Publish.LoadedPublish => ({
  detail: detailOf(INTAKE_TEMPLATE, 'in_review', ['publish']),
  template: INTAKE_TEMPLATE,
  choices: options.choices ?? CHOICES,
  revisions: options.revisions ?? [],
  maybeRound:
    options.round === undefined ? Option.none() : Option.some(options.round),
  whatsapp: options.whatsapp ?? [],
  nowMs: NOW,
  timeZone: 'Europe/Madrid',
})
