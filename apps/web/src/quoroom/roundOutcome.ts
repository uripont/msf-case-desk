import { clsx } from 'clsx'
import { Array, Option } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  type Permission,
  type ReportState,
  type RevisionHeader,
  type Template,
} from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { actionButton } from './entryViews'
import { latestRevisionOf } from './rounds'

// NOTE: What a decided round means for the authors, and what they can do next
// (D18). Pure text first, so each case is tested without a screen:
//
// - `decided` by its rule: a template without a conclusion archives at once
//   (so the report shows as archived); one with a conclusion offers "Start the
//   conclusion" or "Publish another revision".
// - `decided` at its deadline: the votes at the deadline are the outcome; the
//   same two next steps.
// - `concluding`: only the conclusion can be written; the closing revision is
//   shared and published, reviewers review it, and its approval archives the
//   report.
// - `archived`: read-only everywhere.

export type NextAction =
  | 'publish_another'
  | 'start_conclusion'
  | 'publish_closing'

export type Outcome = Readonly<{
  kind: 'decided' | 'concluding' | 'archived'
  heading: string
  body: string
  actions: ReadonlyArray<NextAction>
}>

const can = (
  permissions: ReadonlyArray<Permission>,
  permission: Permission,
): boolean => Array.contains(permissions, permission)

export const outcomeOf = (
  template: Template,
  state: ReportState,
  revisions: ReadonlyArray<RevisionHeader>,
  permissions: ReadonlyArray<Permission>,
): Option.Option<Outcome> => {
  const latest = latestRevisionOf(revisions)
  const label = Option.match(latest, {
    onNone: () => 'The round',
    onSome: revision => revision.label,
  })
  const byDeadline = Option.exists(
    latest,
    revision => revision.status === 'decided' && revision.decidedBy === 'deadline',
  )
  const hasConclusion = template.conclusion !== undefined
  if (state === 'decided') {
    const actions: Array<NextAction> = [
      ...(can(permissions, 'publish') ? (['publish_another'] as const) : []),
      ...(hasConclusion && can(permissions, 'write_conclusion')
        ? (['start_conclusion'] as const)
        : []),
    ]
    return Option.some({
      kind: 'decided',
      heading: byDeadline
        ? `${label} reached its deadline`
        : `${label} was approved`,
      body: byDeadline
        ? 'The approval rule was not met when the deadline passed, so the votes at the deadline are the outcome and the round no longer accepts reviews.'
        : 'The approval rule was met and the round no longer accepts reviews.',
      actions,
    })
  }
  if (state === 'concluding') {
    const closingOpen = Option.exists(
      latest,
      revision => revision.closing && revision.status === 'open',
    )
    const closingByDeadline =
      byDeadline && Option.exists(latest, revision => revision.closing)
    return Option.some({
      kind: 'concluding',
      heading: closingOpen
        ? `${label} is open for review`
        : 'The conclusion is being written',
      body: closingByDeadline
        ? `${label} reached its deadline without the rule being met. Only the conclusion can be changed; publish another closing revision.`
        : closingOpen
          ? 'Reviewers are reading the closing revision. When the approval rule is met the report is archived.'
          : 'Only the conclusion section can be edited now. Share it as a draft and publish it as the closing revision; reviewers review it, and its approval archives the report.',
      actions:
        closingOpen || !can(permissions, 'publish') ? [] : ['publish_closing'],
    })
  }
  if (state === 'archived') {
    return Option.some({
      kind: 'archived',
      heading: 'This report is archived',
      body: hasConclusion
        ? 'The closing revision was approved. The report can be read everywhere and not changed.'
        : 'The latest revision was approved, so the report was archived. It can be read everywhere and not changed.',
      actions: [],
    })
  }
  return Option.none()
}

const linkClass = clsx(
  'inline-flex min-h-11 items-center self-start border border-msf-ink px-4 text-base font-medium text-msf-ink hover:bg-msf-mist',
  focusRing,
)

export const outcomeView = <M>(
  h: HtmlBuilder<M>,
  reportId: string,
  outcome: Outcome,
  onStartConclusion: M,
): Html =>
  h.section(
    [
      h.AriaLabel('Outcome of the round'),
      h.Role('status'),
      h.DataAttribute('outcome', outcome.kind),
      h.Class('flex flex-col gap-3 border-2 border-msf-ink px-4 py-4'),
    ],
    [
      h.h2([h.Class('text-xl font-black text-msf-black')], [outcome.heading]),
      h.p([h.Class('text-pretty text-base text-msf-ink')], [outcome.body]),
      Array.match(outcome.actions, {
        onEmpty: () => h.empty,
        onNonEmpty: actions =>
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            Array.map(actions, action =>
              action === 'start_conclusion'
                ? actionButton(
                    h,
                    'Start the conclusion',
                    'Start the conclusion',
                    onStartConclusion,
                  )
                : h.a(
                    [
                      h.Href(pathOf(AppRoute.Publish({ reportId }))),
                      h.Class(linkClass),
                    ],
                    [
                      action === 'publish_closing'
                        ? 'Publish the closing revision'
                        : 'Publish another revision',
                    ],
                  ),
            ),
          ),
      }),
    ],
  )
