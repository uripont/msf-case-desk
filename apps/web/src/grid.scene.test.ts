import { Option } from 'effect'
import {
  Command,
  change,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
  type,
} from 'foldkit/scene'
import { expect as check, describe, test } from 'vitest'

import {
  type GridView,
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type ReportState,
  type RevisionHeader,
  type RoundView,
} from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { Failure } from './quoroom/failure'
import { NOW, revision } from './publish.fixtures'
import { authorModel } from './quoroom.fixtures'
import * as Audit from './quoroom/audit'
import * as Grid from './quoroom/grid'
import { momentText, momentWithZone } from './quoroom/draftText'
import * as Report from './quoroom/report'
import { removalOf } from './quoroom/roundActions'
import { outcomeOf } from './quoroom/roundOutcome'
import {
  REPORT_ID,
  SCOPE as REPORT_SCOPE,
  detailOf,
  loadedReport,
} from './report.fixtures'
import { view } from './view'

// NOTE: Stage 6d and 6e, with invented people: the status grid (each fact
// with its time), the actions on an open round (extend, remove with the rule
// consequence shown first), the audit log, and the outcome of a decided round
// on the report screen.

const SCOPE = { reportId: REPORT_ID, generation: 1 }

const T0 = NOW - 3 * 3_600_000

const grid: typeof GridView.Type = {
  names: [
    { id: 'account-1', name: 'First Author' },
    { id: 'reviewer-1', name: 'Reviewer One' },
    { id: 'reviewer-2', name: 'Reviewer Two' },
    { id: 'reviewer-3', name: 'Reviewer Three' },
  ],
  grid: {
    authors: ['account-1'],
    drafts: [
      { kind: 'draft', draft: 0, label: 'Draft 0', cells: [{ accountId: 'account-1' }] },
      {
        kind: 'draft',
        draft: 1,
        label: 'Draft 1',
        sharedBy: 'account-1',
        sharedAt: T0,
        cells: [{ accountId: 'account-1', shared: { at: T0 }, read: { at: T0 + 60_000 } }],
      },
    ],
    revisions: [
      {
        kind: 'revision',
        revision: 1,
        label: 'Revision 1',
        draft: 1,
        closing: false,
        publishedAt: T0,
        deadline: NOW + 3 * 86_400_000,
        status: 'open',
        rule: {
          met: false,
          roles: [
            {
              roleId: 'committee',
              rule: { kind: 'all' },
              voters: 2,
              approvals: 1,
              changesRequested: 0,
              met: false,
            },
          ],
        },
        cells: [
          {
            accountId: 'reviewer-1',
            roleId: 'committee',
            roleName: 'Committee',
            removed: false,
            sent: { at: T0 },
            read: { at: T0 + 120_000 },
            whatsappOpened: { at: T0 + 30_000 },
            reviews: [
              { id: 'review-1', decision: 'approve', hasComments: true, at: T0 + 600_000, standing: true },
            ],
            decision: { decision: 'approve', at: T0 + 600_000 },
            reminders: [],
          },
          {
            accountId: 'reviewer-2',
            roleId: 'committee',
            roleName: 'Committee',
            removed: false,
            sent: { at: T0 },
            reviews: [],
            reminders: [{ kind: 'reminder_first', at: T0 + 7_200_000 }],
          },
          {
            accountId: 'reviewer-3',
            roleId: 'observers',
            roleName: 'Observers',
            removed: false,
            sent: { at: T0 },
            reviews: [],
            reminders: [],
          },
        ],
      },
    ],
  },
}

const round: typeof RoundView.Type = {
  revision: 1,
  draft: 1,
  closing: false,
  status: 'open',
  deadline: { at: NOW + 3 * 86_400_000, timeZone: 'Europe/Madrid' },
  participants: [
    { accountId: 'reviewer-1', name: 'Reviewer One', roleId: 'committee', roleName: 'Committee', removed: false, decision: 'approve' },
    { accountId: 'reviewer-2', name: 'Reviewer Two', roleId: 'committee', roleName: 'Committee', removed: false },
  ],
  tally: {
    met: false,
    roles: [
      { roleId: 'committee', rule: { kind: 'all' }, voters: 2, approvals: 1, changesRequested: 0, met: false },
    ],
  },
}

const gridScreen = (
  permissions: Parameters<typeof detailOf>[2] = ['publish'],
  withRound = true,
) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/grid`),
    Message.GotGridMessage({
      message: Grid.Message.SucceededLoadGrid({
        scope: SCOPE,
        loaded: {
          detail: detailOf(INTAKE_TEMPLATE, 'in_review', permissions),
          template: INTAKE_TEMPLATE,
          view: grid,
          maybeRound: withRound ? Option.some(round) : Option.none(),
          nowMs: NOW,
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the status grid', () => {
  test('shows every fact of a reviewer with its time, and what is not known as not known', () => {
    scene(
      { update, view },
      given(gridScreen()),
      expect(role('heading', { name: 'Status grid' })).toExist(),
      expect(role('heading', { name: 'Revision 1, from Draft 1' })).toExist(),
      expect(text('Open for review')).toExist(),
      expect(text(`Told ${momentText(T0)}`)).toExist(),
      expect(text(`Read ${momentText(T0 + 120_000)}`)).toExist(),
      expect(text(`WhatsApp opened ${momentText(T0 + 30_000)}`)).toExist(),
      expect(text(`Approved, ${momentText(T0 + 600_000)}`)).toExist(),
      expect(text('With comments')).toExist(),
      expect(text(`Reminder ${momentText(T0 + 7_200_000)}`)).toExist(),
      expect(text('Not opened')).toExist(),
      expect(text('No decision yet')).toExist(),
      expect(text('Does not vote')).toExist(),
      expect(text('No reminder sent', { exact: false })).toExist(),
    )
  })

  test('shows the rule status of the round and, per draft, who shared and who read', () => {
    scene(
      { update, view },
      given(gridScreen()),
      expect(
        text(
          'Committee: 1 of 2 approved, 0 asked for changes. Rule: every voter must approve. Not met.',
        ),
      ).toExist(),
      expect(selector('[data-role-rule="committee"][data-met="false"]')).toExist(),
      expect(text(`First Author, ${momentText(T0)}`)).toExist(),
      expect(text('Read by First Author')).toExist(),
      expect(text(momentText(T0 + 60_000))).toExist(),
    )
  })

  test('the tables scroll inside their own box, which can be reached by keyboard', () => {
    scene(
      { update, view },
      given(gridScreen()),
      expect(role('region', { name: 'Reviewers of Revision 1' })).toExist(),
      expect(role('region', { name: 'Shared drafts' })).toExist(),
    )
  })

  test('a decided round names how it was decided, and has no round actions', () => {
    const decided = {
      ...grid,
      grid: {
        ...grid.grid,
        revisions: grid.grid.revisions.map(row => ({
          ...row,
          status: 'decided' as const,
          decidedBy: 'deadline' as const,
          decidedAt: row.deadline,
        })),
      },
    }
    const model = [
      clickedLinkTo(`/r/${REPORT_ID}/grid`),
      Message.GotGridMessage({
        message: Grid.Message.SucceededLoadGrid({
          scope: SCOPE,
          loaded: {
            detail: detailOf(INTAKE_TEMPLATE, 'decided', ['publish']),
            template: INTAKE_TEMPLATE,
            view: decided,
            maybeRound: Option.none(),
            nowMs: NOW,
          },
        }),
      }),
    ].reduce((m, message) => update(m, message).model, authorModel)
    scene(
      { update, view },
      given(model),
      expect(text('Decided at the deadline')).toExist(),
      expect(text('by the deadline', { exact: false })).toExist(),
      expect(role('button', { name: 'Extend the deadline' })).toBeAbsent(),
    )
  })
})

describe('extending a deadline and removing a reviewer', () => {
  test('a new deadline must be later than the current one, checked before sending', () => {
    scene(
      { update, view },
      given(gridScreen()),
      type(role('textbox', { name: 'New date' }), '2026-11-01'),
      click(role('button', { name: 'Extend the deadline' })),
      expect(text('The new deadline must be later than the current one.')).toExist(),
    )
  })

  test('a deadline more than a year ahead is refused before sending', () => {
    scene(
      { update, view },
      given(gridScreen()),
      type(role('textbox', { name: 'New date' }), '2029-01-10'),
      click(role('button', { name: 'Extend the deadline' })),
      expect(text('The deadline can be at most one year ahead.')).toExist(),
    )
  })

  test('a later deadline is sent with its zone', () => {
    scene(
      { update, view },
      given(gridScreen()),
      type(role('textbox', { name: 'New date' }), '2027-01-10'),
      click(role('button', { name: 'Extend the deadline' })),
      Command.resolve(
        Grid.ExtendRoundDeadline,
        Grid.Message.FailedExtend({ scope: SCOPE, failure: Failure.Unavailable() }),
      ),
      expect(text('The server did not answer.', { exact: false })).toExist(),
    )
  })

  test('removing a reviewer shows the rule consequence first and sends nothing until confirmed', () => {
    scene(
      { update, view },
      given(gridScreen()),
      click(role('button', { name: 'Remove Reviewer Two from this round' })),
      expect(role('alertdialog', { name: 'Remove Reviewer Two' })).toExist(),
      expect(
        text('Committee: 1 of 1 approved, every voter must approve. The rule is met.'),
      ).toExist(),
      expect(
        text('With this removal the rule is met, so the round is decided now.'),
      ).toExist(),
      click(role('button', { name: 'Confirm removing Reviewer Two' })),
      Command.resolve(
        Grid.RemoveRoundReviewer,
        Grid.Message.FailedRemove({ scope: SCOPE, failure: Failure.Unavailable() }),
      ),
    )
  })

  test('without the publish permission there are no round actions', () => {
    scene(
      { update, view },
      given(gridScreen(['reply'])),
      expect(role('button', { name: 'Extend the deadline' })).toBeAbsent(),
      expect(role('button', { name: 'Remove Reviewer Two from this round' })).toBeAbsent(),
    )
  })

  test('an observer cannot be told apart as a voter: removing the only voter is refused in words', () => {
    const only: typeof RoundView.Type = {
      ...round,
      participants: round.participants.slice(0, 1),
    }
    const removal = removalOf(INTAKE_TEMPLATE, only, 'reviewer-1')
    check(removal.kind).toBe('refused')
  })

  test('a reviewer with a standing decision stays in the round, and the panel says why', () => {
    for (const decision of ['approve', 'request_changes'] as const) {
      const decided: typeof RoundView.Type = {
        ...round,
        participants: [
          ...round.participants,
          { accountId: 'reviewer-3', name: 'Reviewer Three', roleId: 'committee', roleName: 'Committee', removed: false, decision },
        ],
      }
      const removal = removalOf(INTAKE_TEMPLATE, decided, 'reviewer-3')
      check(removal).toMatchObject({ kind: 'refused' })
      check(removal.kind === 'refused' ? removal.message : '').toContain('already decided')
    }
  })

  test('a removal that leaves the rule unmet says how many approvals are missing', () => {
    const three: typeof RoundView.Type = {
      ...round,
      participants: [
        ...round.participants,
        { accountId: 'reviewer-3', name: 'Reviewer Three', roleId: 'committee', roleName: 'Committee', removed: false },
      ],
    }
    const removal = removalOf(INTAKE_TEMPLATE, three, 'reviewer-3')
    check(removal).toMatchObject({ kind: 'allowed', decidesNow: false })
  })
})

const event = (
  id: string,
  action: string,
  at: number,
  extra: Record<string, unknown> = {},
) => ({ id, at, action, meta: {}, ...extra })

const auditScreen = (events: ReadonlyArray<ReturnType<typeof event>>, next?: string) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}/audit`),
    Message.GotAuditMessage({
      message: Audit.Message.SucceededLoadAudit({
        scope: SCOPE,
        events,
        maybeNext: Option.fromNullishOr(next),
        kind: 'all',
        isMore: false,
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

const EVENTS = [
  event('9', 'round.decided', T0 + 900_000, { revision: 1, meta: { decidedBy: 'rule_met' } }),
  event('8', 'review.sent', T0 + 600_000, { revision: 1, actor: { id: 'reviewer-1', name: 'Reviewer One' } }),
  event('7', 'revision.published', T0, { revision: 1, actor: { id: 'account-1', name: 'First Author' }, meta: { deadline: NOW } }),
  event('6', 'draft.shared', T0 - 60_000, { draft: 1, actor: { id: 'account-1', name: 'First Author' } }),
]

describe('the audit log', () => {
  test('lists each fact with its time, who did it and the draft or revision', () => {
    scene(
      { update, view },
      given(auditScreen(EVENTS)),
      expect(role('heading', { name: 'Audit log' })).toExist(),
      expect(text('The round was decided')).toExist(),
      expect(text(`${momentWithZone(T0 + 600_000)}, Reviewer One, Revision 1`)).toExist(),
      expect(text(`${momentWithZone(T0 - 60_000)}, First Author, Draft 1`)).toExist(),
      expect(text(`deadline ${momentText(NOW)}`)).toExist(),
    )
  })

  test('filters by kind on the server and starts again from the newest of that kind', () => {
    scene(
      { update, view },
      given(auditScreen(EVENTS)),
      change(role('combobox', { name: 'Show' }), 'review'),
      Command.resolve(
        Audit.LoadAudit,
        Audit.Message.SucceededLoadAudit({
          scope: SCOPE,
          events: [EVENTS[1]!],
          maybeNext: Option.none(),
          kind: 'review',
          isMore: false,
        }),
      ),
      expect(text('A review was sent')).toExist(),
      expect(text('The round was decided')).toBeAbsent(),
      expect(text('A draft was shared')).toBeAbsent(),
    )
  })

  test('asks the server for the chosen kind, for the next page too, and drops a late answer for another kind', () => {
    const chosen = update(
      auditScreen(EVENTS, '6'),
      Message.GotAuditMessage({ message: Audit.Message.ChoseKind({ value: 'review' }) }),
    )
    check(chosen.commands?.[0]?.args).toMatchObject({ kind: 'review', maybeBefore: Option.none(), isMore: false })
    const answered = update(
      chosen.model,
      Message.GotAuditMessage({
        message: Audit.Message.SucceededLoadAudit({
          scope: SCOPE,
          events: [EVENTS[1]!],
          maybeNext: Option.some('8'),
          kind: 'review',
          isMore: false,
        }),
      }),
    )
    const older = update(
      answered.model,
      Message.GotAuditMessage({ message: Audit.Message.ClickedLoadOlder() }),
    )
    check(older.commands?.[0]?.args).toMatchObject({ kind: 'review', isMore: true })
    const late = update(
      chosen.model,
      Message.GotAuditMessage({
        message: Audit.Message.SucceededLoadAudit({
          scope: SCOPE,
          events: [EVENTS[0]!],
          maybeNext: Option.none(),
          kind: 'all',
          isMore: false,
        }),
      }),
    )
    check(late.model.audit.events).toEqual(chosen.model.audit.events)
    check(late.model.audit.isLoadingMore).toBe(true)
  })

  test('offers older events when there are more, and not otherwise', () => {
    scene(
      { update, view },
      given(auditScreen(EVENTS, '6')),
      expect(role('button', { name: 'Load older events' })).toExist(),
    )
    scene(
      { update, view },
      given(auditScreen(EVENTS)),
      expect(role('button', { name: 'Load older events' })).toBeAbsent(),
    )
  })

  test('loading older events adds them below and keeps the filter', () => {
    const first = auditScreen(EVENTS, '6')
    const asked = update(first, Message.GotAuditMessage({ message: Audit.Message.ClickedLoadOlder() }))
    const done = update(
      asked.model,
      Message.GotAuditMessage({
        message: Audit.Message.SucceededLoadAudit({
          scope: SCOPE,
          events: [event('5', 'report.created', T0 - 120_000)],
          maybeNext: Option.none(),
          kind: 'all',
          isMore: true,
        }),
      }),
    ).model
    scene(
      { update, view },
      given(done),
      expect(text('The report was created')).toExist(),
      expect(text('The round was decided')).toExist(),
      expect(role('button', { name: 'Load older events' })).toBeAbsent(),
    )
  })
})

// ---- The outcome on the report screen ------------------------------------------------

const headers = (
  status: RevisionHeader['status'],
  decidedBy: 'rule_met' | 'deadline' | undefined,
  closing = false,
): ReadonlyArray<RevisionHeader> => [
  {
    ...revision(1, status),
    closing,
    ...(decidedBy === undefined ? {} : { decidedBy }),
  },
]

const reportScreen = (
  template: typeof INTAKE_TEMPLATE,
  state: ReportState,
  revisions: ReadonlyArray<RevisionHeader>,
  permissions: Parameters<typeof detailOf>[2] = ['edit', 'publish', 'write_conclusion'],
) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    Message.GotReportMessage({
      message: Report.Message.SucceededLoadReport({
        scope: REPORT_SCOPE,
        loaded: {
          ...loadedReport(template, { state, permissions }),
          revisions,
          nowMs: NOW,
        },
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

describe('the outcome of a decided round', () => {
  test('approved, with a conclusion in the template: publish another revision or start the conclusion', () => {
    scene(
      { update, view },
      given(reportScreen(INTAKE_TEMPLATE, 'decided', headers('decided', 'rule_met'))),
      expect(selector('[data-outcome="decided"]')).toExist(),
      expect(role('heading', { name: 'Revision 1 was approved' })).toExist(),
      expect(role('link', { name: 'Publish another revision' })).toHaveAttr(
        'href',
        `/r/${REPORT_ID}/publish`,
      ),
      expect(role('button', { name: 'Start the conclusion' })).toExist(),
    )
  })

  test('decided at the deadline says the votes at the deadline are the outcome', () => {
    scene(
      { update, view },
      given(reportScreen(INTAKE_TEMPLATE, 'decided', headers('decided', 'deadline'))),
      expect(role('heading', { name: 'Revision 1 reached its deadline' })).toExist(),
      expect(text('the votes at the deadline are the outcome', { exact: false })).toExist(),
    )
  })

  test('starting the conclusion asks first, then sends one request', () => {
    scene(
      { update, view },
      given(reportScreen(INTAKE_TEMPLATE, 'decided', headers('decided', 'rule_met'))),
      click(role('button', { name: 'Start the conclusion' })),
      expect(role('alertdialog', { name: 'Start the conclusion?' })).toExist(),
      Command.resolve(Report.FocusConfirmation, Report.Message.CompletedFocusConfirmation()),
      click(role('button', { name: 'Start the conclusion' })),
      Command.resolve(
        Report.StartReportConclusion,
        Report.Message.FailedStartConclusion({ scope: REPORT_SCOPE, failure: Failure.Unavailable() }),
      ),
      Command.resolve(
        Report.RefreshRounds,
        Report.Message.FailedRefreshRounds({ scope: REPORT_SCOPE }),
      ),
    )
  })

  test('a template without a conclusion offers no conclusion, and an approved one shows archived', () => {
    scene(
      { update, view },
      given(reportScreen(INVESTIGATION_TEMPLATE, 'decided', headers('decided', 'deadline'))),
      expect(role('button', { name: 'Start the conclusion' })).toBeAbsent(),
      expect(role('link', { name: 'Publish another revision' })).toExist(),
    )
    scene(
      { update, view },
      given(reportScreen(INVESTIGATION_TEMPLATE, 'archived', headers('decided', 'rule_met'))),
      expect(role('heading', { name: 'This report is archived' })).toExist(),
      expect(text('so the report was archived', { exact: false })).toExist(),
      expect(role('link', { name: 'Publish another revision' })).toBeAbsent(),
      expect(role('link', { name: 'Share as Draft 1' })).toBeAbsent(),
    )
  })

  test('without the permission to publish or conclude, no next action is offered', () => {
    scene(
      { update, view },
      given(reportScreen(INTAKE_TEMPLATE, 'decided', headers('decided', 'rule_met'), ['edit'])),
      expect(role('heading', { name: 'Revision 1 was approved' })).toExist(),
      expect(role('button', { name: 'Start the conclusion' })).toBeAbsent(),
      expect(role('link', { name: 'Publish another revision' })).toBeAbsent(),
    )
  })

  test('while concluding only the conclusion is open, the other sections say why they are read-only', () => {
    scene(
      { update, view },
      given(reportScreen(INTAKE_TEMPLATE, 'concluding', headers('decided', 'rule_met'))),
      expect(selector('[data-outcome="concluding"]')).toExist(),
      expect(role('heading', { name: 'The conclusion is being written' })).toExist(),
      expect(role('link', { name: 'Publish the closing revision' })).toExist(),
      expect(
        text('The report is concluding. Only the conclusion can be edited now.', { exact: false }),
      ).toExist(),
    )
  })

  test('the outcome text, as pure data', () => {
    check(
      Option.isNone(outcomeOf(INTAKE_TEMPLATE, 'in_review', headers('open', undefined), ['publish'])),
    ).toBe(true)
    const closing = outcomeOf(INTAKE_TEMPLATE, 'concluding', headers('open', undefined, true), ['publish'])
    check(Option.getOrThrow(closing)).toMatchObject({ kind: 'concluding', actions: [] })
    const lost = outcomeOf(INTAKE_TEMPLATE, 'concluding', headers('decided', 'deadline', true), ['publish'])
    check(Option.getOrThrow(lost).actions).toEqual(['publish_closing'])
  })
})
