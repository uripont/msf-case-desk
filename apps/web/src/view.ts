import { clsx } from 'clsx'
import { Array, Match, Option } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'

import {
  type MeView,
  PRIORITIES,
  type Priority,
  type RuntimeMode,
  type SlaStatus,
  type TriagedCase,
  describeReason,
  priorityLabel,
} from '@case-desk/domain'

import { type ApiFailure } from './api'
import { PRODUCT_NAME } from './brand'
import { entryPage } from './entryView'
import { formatInstant, formatSla, formatSlaShort, humanise } from './format'
import { loginPage } from './loginView'
import {
  CENTRE_FILTERS,
  type CentreFilter,
  ConfigLoad,
  DeskLoad,
  LEAVE_HEADING_ID,
  Message,
  type Model,
  PAGE_HEADING_ID,
  Session,
  dueSoonCountOf,
  maybeSelectedOf,
  modeOf,
  overdueCountOf,
  rulesOf,
  themeOf,
  visibleQueueOf,
} from './main'
import * as Account from './quoroom/account'
import * as Admin from './quoroom/admin'
import { actionButton } from './quoroom/entryViews'
import * as Audit from './quoroom/audit'
import * as Comments from './quoroom/comments'
import * as Downloads from './quoroom/downloads'
import * as Grid from './quoroom/grid'
import * as History from './quoroom/history'
import * as Inbox from './quoroom/inbox'
import * as Notifications from './quoroom/notifications'
import * as Link from './quoroom/link'
import * as Names from './quoroom/names'
import * as Publish from './quoroom/publish'
import * as Report from './quoroom/report'
import * as Review from './quoroom/review'
import * as Reports from './quoroom/reports'
import * as Share from './quoroom/share'
import * as Unit from './quoroom/unit'
import { AppRoute, isTriageRoute, pathOf } from './route'
import { rulesPage } from './rulesView'
import { focusRing, outlineButtonClassName, textButtonClassName } from './style'
import { themeStyle } from './theme'
import { hoverAttributes, markGlyphClassName, timeAxis } from './timeAxis'

// COPY

const priorityTitle = (priority: Priority): string => {
  const label = priorityLabel(priority)
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`
}

const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many

const headline = (overdue: number, dueSoon: number): string => {
  if (overdue > 0) {
    return `${overdue} ${plural(overdue, 'case is', 'cases are')} overdue`
  }
  if (dueSoon > 0) {
    return `${dueSoon} ${plural(dueSoon, 'case is', 'cases are')} due soon`
  }
  return 'Everything is on track'
}

const centreLabel = (centreFilter: CentreFilter): string =>
  centreFilter === 'All' ? 'All centres' : centreFilter

const scopePhrase = (centreFilter: CentreFilter): string =>
  centreFilter === 'All' ? 'across all centres' : `in ${centreFilter}`

const lede = (
  centreFilter: CentreFilter,
  openCount: number,
  urgentCount: number,
): string => {
  const open = `${openCount} open ${plural(openCount, 'case', 'cases')} ${scopePhrase(centreFilter)}.`
  return urgentCount === 0
    ? `${open} None urgent.`
    : `${open} ${urgentCount} urgent.`
}

// STYLE

const sectionRuleClassName = (priority: Priority): string =>
  Match.value(priority).pipe(
    Match.when('P1', () => 'border-msf-red'),
    Match.when('P2', () => 'border-msf-ink'),
    Match.when('P3', () => 'border-msf-ink'),
    Match.exhaustive,
  )

const priorityTextClassName = (priority: Priority): string =>
  Match.value(priority).pipe(
    Match.when('P1', () => 'text-msf-red'),
    Match.when('P2', () => 'text-msf-ink'),
    Match.when('P3', () => 'text-msf-grey'),
    Match.exhaustive,
  )

const slaClassName = (sla: SlaStatus): string =>
  Match.value(sla).pipe(
    Match.tagsExhaustive({
      OnTrack: () => 'text-msf-grey',
      DueSoon: () => 'font-medium text-msf-ink',
      Overdue: () => 'font-medium text-msf-red',
    }),
  )

// VIEW

const movingBlockStyle = (
  model: Model,
  name: string,
): Record<string, string> =>
  model.heroLayout === 'Responsive' || model.isDetailSheetOpen
    ? {}
    : { viewTransitionName: name }

const centreTab = (
  model: Model,
  centreFilter: CentreFilter,
  h: HtmlBuilder<Message>,
): Html => {
  const isActive = model.centreFilter === centreFilter

  return h.button(
    [
      h.Class(
        clsx(
          'relative inline-flex h-11 shrink-0 cursor-pointer items-center whitespace-nowrap text-base transition-colors after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-msf-ink',
          isActive
            ? 'font-medium text-msf-ink after:bg-msf-red'
            : 'text-msf-grey after:bg-transparent hover:text-msf-ink hover:after:bg-msf-line',
        ),
      ),
      h.AriaPressed(isActive ? 'true' : 'false'),
      h.OnClick(Message.SelectedCentreFilter({ centreFilter })),
    ],
    [centreLabel(centreFilter)],
  )
}

const wordmark = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-4 pb-2 md:pb-3')],
    [
      Option.match(model.maybeLogoSrc, {
        onNone: () => h.empty,
        onSome: src =>
          h.img([
            h.Src(src),
            h.Alt(`${themeOf(model).organisationName} logo`),
            h.Class('block h-10 w-auto'),
          ]),
      }),
      h.p(
        [
          h.Class(
            'flex flex-wrap items-baseline gap-x-3 text-xl font-black tracking-tight text-msf-black',
          ),
        ],
        [
          PRODUCT_NAME,
          h.span(
            [h.Class('text-base font-normal text-msf-grey')],
            [themeOf(model).organisationName],
          ),
        ],
      ),
    ],
  )

const hasCapability = (
  me: MeView,
  capability: 'admin' | 'author' | 'template_editor',
): boolean => Array.some(me.grants, grant => grant.capability === capability)

type PageLink = { route: AppRoute; label: string }

const pageLinksFor = (
  me: MeView,
  mode: RuntimeMode,
  unread: number,
): ReadonlyArray<PageLink> => [
  ...(mode === 'demo'
    ? [
        { route: AppRoute.Desk(), label: 'Cases' },
        { route: AppRoute.NewCase(), label: 'New case' },
        { route: AppRoute.Rules(), label: 'Rules' },
      ]
    : [{ route: AppRoute.Desk(), label: 'Home' }]),
  ...(hasCapability(me, 'author')
    ? [
        { route: AppRoute.Unit(), label: 'My unit' },
        { route: AppRoute.Reports(), label: 'Reports' },
      ]
    : []),
  ...(hasCapability(me, 'admin')
    ? [{ route: AppRoute.Admin(), label: 'Administration' }]
    : []),
  { route: AppRoute.Inbox(), label: 'Inbox' },
  {
    route: AppRoute.Notifications(),
    label: Notifications.unreadLabel('Notifications', unread),
  },
  { route: AppRoute.Account(), label: 'My account' },
]

const pageLink = (
  model: Model,
  { route, label }: PageLink,
  h: HtmlBuilder<Message>,
): Html => {
  const isCurrent = pathOf(model.route) === pathOf(route)
  return h.a(
    [
      h.Href(pathOf(route)),
      h.Class(
        clsx(
          'cursor-pointer text-base transition-colors',
          focusRing,
          isCurrent
            ? 'font-medium text-msf-black underline decoration-msf-red decoration-2 underline-offset-[6px]'
            : 'text-msf-grey hover:text-msf-ink',
        ),
      ),
      ...(isCurrent ? [h.AriaCurrent('page')] : []),
    ],
    [label],
  )
}

const accountBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  Session.match(model.session, {
    Checking: () => h.empty,
    SignedOut: () => h.empty,
    SignedIn: ({ me }) =>
      h.div(
        [
          h.Class(
            'flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pt-4 text-sm text-msf-grey',
          ),
        ],
        [
          h.nav(
            [h.AriaLabel('Pages'), h.Class('flex flex-wrap gap-x-6 gap-y-2')],
            Array.map(pageLinksFor(me, modeOf(model), model.notifications.unread), link =>
              pageLink(model, link, h),
            ),
          ),
          h.div(
            [h.Class('flex items-baseline gap-x-4')],
            [
              h.span([], [me.name]),
              h.button(
                [
                  h.Class(textButtonClassName),
                  h.OnClick(Message.ClickedSignOut()),
                ],
                ['Sign out'],
              ),
            ],
          ),
        ],
      ),
  })

const centreNav = (model: Model, h: HtmlBuilder<Message>): Html =>
  Session.match(model.session, {
    Checking: () => h.empty,
    SignedOut: () => h.empty,
    SignedIn: () =>
      modeOf(model) === 'demo' && AppRoute.guards.Desk(model.route)
        ? centreTabs(model, h)
        : h.empty,
  })

const topBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [],
    [
      accountBar(model, h),
      h.div(
        [
          h.Class(
            'flex flex-col gap-x-12 border-b border-msf-line pt-5 md:flex-row md:items-end md:justify-between md:pt-6',
          ),
        ],
        [wordmark(model, h), centreNav(model, h)],
      ),
    ],
  )

const centreTabs = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.nav(
    [
      h.AriaLabel('Operational centre'),
      h.Class(
        '-mx-5 flex gap-x-6 overflow-x-auto px-5 [scrollbar-width:none] sm:-mx-10 sm:px-10 md:mx-0 md:gap-x-7 md:overflow-visible md:px-0',
      ),
    ],
    Array.map(CENTRE_FILTERS, centreFilter =>
      centreTab(model, centreFilter, h),
    ),
  )

const intro = (model: Model, h: HtmlBuilder<Message>): Html => {
  const queue = visibleQueueOf(model)
  const urgentCount = Array.filter(
    queue,
    triaged => triaged.result.priority === 'P1',
  ).length

  return h.section(
    [
      h.AriaLabel('Queue summary'),
      h.Class('flex flex-col gap-4 pb-14 pt-12 md:gap-5 md:pb-20 md:pt-16'),
    ],
    [
      h.h1(
        [
          h.Id(PAGE_HEADING_ID),
          h.Class(
            'max-w-4xl text-balance text-[2.75rem] font-black text-msf-black leading-[1.02] tracking-[-0.025em] sm:text-6xl md:text-7xl',
          ),
        ],
        [headline(overdueCountOf(model), dueSoonCountOf(model))],
      ),
      h.p(
        [
          h.Class(
            'max-w-2xl text-pretty text-xl font-light text-msf-ink md:text-2xl',
          ),
        ],
        [lede(model.centreFilter, queue.length, urgentCount)],
      ),
      timeAxis(model, h),
    ],
  )
}

const queueRow = (
  model: Model,
  triaged: TriagedCase,
  h: HtmlBuilder<Message>,
): Html => {
  const { triageCase, result, sla } = triaged
  const isSelected = Option.exists(
    model.maybeSelectedCaseId,
    selectedId => selectedId === triageCase.id,
  )
  const isHighlighted = Option.exists(
    model.maybeHighlightedCaseId,
    highlightedId => highlightedId === triageCase.id,
  )

  return h.keyed('li')(
    triageCase.id,
    [],
    [
      h.button(
        [
          h.Class(
            clsx(
              'grid w-full cursor-pointer grid-cols-1 gap-x-8 gap-y-1.5 border-l-[3px] py-5 pl-4 pr-3 text-left transition-colors sm:grid-cols-[minmax(0,1fr)_auto] sm:items-baseline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-msf-ink',
              isSelected ? 'border-msf-red' : 'border-transparent',
              isSelected || isHighlighted ? 'bg-msf-mist' : 'hover:bg-msf-mist',
            ),
          ),
          h.AriaPressed(isSelected ? 'true' : 'false'),
          h.OnClick(Message.ClickedCase({ caseId: triageCase.id })),
          ...hoverAttributes(triageCase.id, isHighlighted, h),
          h.OnFocus(Message.EnteredCase({ caseId: triageCase.id })),
          h.OnBlur(Message.LeftCase()),
        ],
        [
          h.span(
            [h.Class('text-lg font-medium leading-snug text-pretty')],
            [triageCase.summary],
          ),
          h.span(
            [
              h.Class(
                clsx(
                  'whitespace-nowrap tabular-nums text-base sm:row-span-2 sm:text-right',
                  slaClassName(sla),
                ),
              ),
            ],
            [formatSlaShort(sla)],
          ),
          h.span(
            [
              h.Class(
                'flex flex-wrap gap-x-3 text-[15px] tabular-nums text-msf-grey sm:col-start-1',
              ),
            ],
            [
              h.span(
                [h.AriaHidden(true), h.Class('inline-flex w-3 items-center')],
                [
                  h.span([
                    h.Class(
                      clsx(
                        'block',
                        markGlyphClassName(result.priority, result.isFastTrack),
                      ),
                    ),
                  ]),
                ],
              ),
              h.span([], [triageCase.id]),
              h.span([], [triageCase.centre]),
              h.span([], [humanise(triageCase.channel)]),
              result.isFastTrack
                ? h.span([h.Class('font-medium text-msf-red')], ['Fast-track'])
                : h.empty,
            ],
          ),
        ],
      ),
    ],
  )
}

const prioritySection = (
  model: Model,
  priority: Priority,
  rows: ReadonlyArray<TriagedCase>,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [h.AriaLabel(priorityTitle(priority)), h.Class('flex flex-col')],
    [
      h.div(
        [
          h.Class(
            clsx(
              'flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-t-2 pb-3 pt-4',
              sectionRuleClassName(priority),
            ),
          ),
        ],
        [
          h.h2(
            [
              h.Class(
                'text-[1.75rem] font-medium leading-tight tracking-tight',
              ),
            ],
            [priorityTitle(priority)],
          ),
          h.p(
            [h.Class('text-base tabular-nums text-msf-grey')],
            [
              `${rows.length} ${plural(rows.length, 'case', 'cases')}, assess within ${rulesOf(model).targetHours[priority]} hours`,
            ],
          ),
        ],
      ),
      h.ul(
        [
          h.Class(
            'm-0 flex list-none flex-col divide-y divide-msf-line border-b border-msf-line p-0',
          ),
        ],
        Array.map(rows, row => queueRow(model, row, h)),
      ),
    ],
  )

const queueList = (model: Model, h: HtmlBuilder<Message>): Html => {
  const queue = visibleQueueOf(model)

  return h.section(
    [
      h.AriaLabel('Priority queue'),
      h.Class('flex flex-col gap-14'),
      h.Style(movingBlockStyle(model, 'queue-list')),
    ],
    Array.match(queue, {
      onEmpty: () => [
        h.div(
          [
            h.Class(
              'flex flex-col items-start gap-5 border-t-2 border-msf-ink pt-5',
            ),
          ],
          [
            h.p(
              [h.Class('text-2xl font-light text-msf-grey')],
              [
                Array.isReadonlyArrayEmpty(model.cases)
                  ? 'No cases yet.'
                  : 'No cases for this centre.',
              ],
            ),
            h.a(
              [
                h.Href(pathOf(AppRoute.NewCase())),
                h.Class(outlineButtonClassName),
              ],
              ['Enter a case'],
            ),
          ],
        ),
      ],
      onNonEmpty: () =>
        Array.flatMap(PRIORITIES, priority => {
          const rows = Array.filter(
            queue,
            triaged => triaged.result.priority === priority,
          )
          return Array.match(rows, {
            onEmpty: () => [],
            onNonEmpty: nonEmptyRows => [
              prioritySection(model, priority, nonEmptyRows, h),
            ],
          })
        }),
    }),
  )
}

const detailSentence = (triaged: TriagedCase): string => {
  const { triageCase } = triaged

  return `Reported to ${triageCase.centre} through ${humanise(triageCase.channel)} on ${formatInstant(triageCase.receivedAt)}. ${triageCase.scope} scope, ${triageCase.risk.toLowerCase()} risk, ${triageCase.urgency.toLowerCase()} urgency.`
}

const detailAsideClassName =
  'lg:sticky lg:top-10 lg:self-start lg:border-l lg:border-msf-line lg:pl-12'

const reasonItem = (
  reason: string,
  index: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.li(
    [h.Class('grid grid-cols-[1.75rem_1fr] gap-x-2 py-3 text-base')],
    [
      h.span(
        [h.Class('tabular-nums text-msf-grey'), h.AriaHidden(true)],
        [`${index + 1}`],
      ),
      h.span([], [reason]),
    ],
  )

const detailPanel = (
  triaged: TriagedCase,
  isSheetOpen: boolean,
  transitionStyle: Record<string, string>,
  h: HtmlBuilder<Message>,
): Html => {
  const { triageCase, result, sla } = triaged

  return h.aside(
    [
      h.AriaLabel('Case detail'),
      h.Style(transitionStyle),
      h.Class(
        clsx(
          'flex-col gap-8',
          isSheetOpen
            ? 'fixed inset-0 z-30 flex overflow-y-auto overscroll-contain bg-white px-6 pb-12 pt-4 sm:px-10 lg:static lg:z-auto lg:overflow-visible lg:bg-transparent lg:p-0'
            : 'hidden lg:flex',
          detailAsideClassName,
        ),
      ),
    ],
    [
      h.button(
        [
          h.Class(
            clsx(
              'sticky top-0 -mx-6 -mt-4 mb-2 flex min-h-14 cursor-pointer items-center gap-2 border-b border-msf-line bg-white px-6 text-left text-lg font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-msf-ink sm:-mx-10 sm:px-10 lg:hidden',
            ),
          ),
          h.OnClick(Message.ClickedCloseDetail()),
        ],
        ['← Back to cases'],
      ),
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.p(
            [h.Class('flex flex-wrap gap-x-3 text-base tabular-nums')],
            [
              h.span([h.Class('text-msf-grey')], [triageCase.id]),
              h.span(
                [
                  h.Class(
                    clsx('font-medium', priorityTextClassName(result.priority)),
                  ),
                ],
                [priorityTitle(result.priority)],
              ),
            ],
          ),
          h.h2(
            [
              h.Class(
                'text-[1.625rem] font-medium leading-tight tracking-tight text-pretty md:text-3xl',
              ),
            ],
            [triageCase.summary],
          ),
          h.p(
            [h.Class(clsx('text-lg tabular-nums', slaClassName(sla)))],
            [formatSla(sla)],
          ),
        ],
      ),
      h.p(
        [h.Class('max-w-prose text-[17px] leading-relaxed text-msf-ink')],
        [detailSentence(triaged)],
      ),
      triageCase.details === ''
        ? h.empty
        : h.p(
            [
              h.Class(
                'max-w-prose whitespace-pre-line border-l-2 border-msf-line pl-4 text-base leading-relaxed text-msf-ink',
              ),
            ],
            [triageCase.details],
          ),
      triageCase.enteredByName === ''
        ? h.empty
        : h.p(
            [h.Class('text-sm text-msf-grey')],
            [
              `Entered by ${triageCase.enteredByName} on ${formatInstant(triageCase.enteredAt)}.`,
            ],
          ),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.h3(
            [h.Class('text-xl font-medium tracking-tight')],
            [`Why this is ${priorityLabel(result.priority)}`],
          ),
          h.ol(
            [
              h.Class(
                'm-0 flex list-none flex-col divide-y divide-msf-line border-y border-msf-line p-0',
              ),
            ],
            Array.map(result.reasons, (reason, index) =>
              reasonItem(describeReason(reason), index, h),
            ),
          ),
          h.p(
            [h.Class('pt-2 text-base text-msf-grey')],
            [
              `Assess by ${formatInstant(result.dueAt)}, ${result.targetHours} hours after it was received.`,
            ],
          ),
        ],
      ),
      h.button(
        [
          h.Class(
            clsx('hidden self-start text-base lg:inline', textButtonClassName),
          ),
          h.OnClick(Message.ClickedCloseDetail()),
        ],
        ['Close'],
      ),
    ],
  )
}

const emptyDetail = (
  transitionStyle: Record<string, string>,
  h: HtmlBuilder<Message>,
): Html =>
  h.aside(
    [
      h.AriaLabel('Case detail'),
      h.Style(transitionStyle),
      h.Class(
        clsx(
          'hidden text-2xl font-light leading-snug text-msf-grey lg:block',
          detailAsideClassName,
        ),
      ),
    ],
    [h.p([], ['Pick a case to see why it has its priority.'])],
  )

const footer = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.footer(
    [
      h.Class(
        'mt-24 flex flex-col gap-3 border-t border-msf-line pb-12 pt-8 md:mt-32',
      ),
    ],
    [
      h.p(
        [h.Class('max-w-3xl text-base leading-relaxed text-msf-ink')],
        [
          `${PRODUCT_NAME}, a reporting system for ${themeOf(model).organisationName}.`,
        ],
      ),
      h.p(
        [h.Class('max-w-3xl text-sm leading-relaxed text-msf-grey')],
        [
          'A prototype developed at Universitat Pompeu Fabra as part of our Project Management course.',
        ],
      ),
    ],
  )

const deskMessage = (
  title: string,
  body: string,
  h: HtmlBuilder<Message>,
  maybeAction: Option.Option<Html> = Option.none(),
): Html =>
  h.section(
    [
      h.AriaLabel('Case desk status'),
      h.Class('flex flex-col items-start gap-4 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [
      h.h1(
        [
          h.Class(
            'max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
          ),
        ],
        [title],
      ),
      h.p(
        [h.Class('max-w-2xl text-pretty text-xl font-light text-msf-ink')],
        [body],
      ),
      Option.getOrElse(maybeAction, () => h.empty),
    ],
  )

const loadingDesk = (h: HtmlBuilder<Message>): Html =>
  deskMessage('Loading cases', 'Getting the latest cases and rules.', h)

const failedDesk = (failure: ApiFailure, h: HtmlBuilder<Message>): Html =>
  Match.value(failure).pipe(
    Match.when('SignInRequired', () =>
      deskMessage('Sign in to see the cases', 'Your session has ended.', h),
    ),
    Match.when('Unavailable', () =>
      deskMessage(
        'The cases could not be loaded',
        'The case desk did not answer. Check your connection and try again.',
        h,
        Option.some(
          h.button(
            [
              h.Class(outlineButtonClassName),
              h.OnClick(Message.ClickedRetryLoad()),
            ],
            ['Try again'],
          ),
        ),
      ),
    ),
    Match.exhaustive,
  )

const loadedDesk = (
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> => [
  intro(model, h),
  h.div(
    [
      h.Class(
        'grid gap-16 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:gap-20',
      ),
    ],
    [
      queueList(model, h),
      Option.match(maybeSelectedOf(model), {
        onNone: () => emptyDetail(movingBlockStyle(model, 'case-detail'), h),
        onSome: triaged =>
          detailPanel(
            triaged,
            model.isDetailSheetOpen,
            movingBlockStyle(model, 'case-detail'),
            h,
          ),
      }),
    ],
  ),
]

const deskPageView = (
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  DeskLoad.match(model.deskLoad, {
    Loading: () => [loadingDesk(h)],
    Failed: ({ failure }) => [failedDesk(failure, h)],
    Loaded: () =>
      AppRoute.match<ReadonlyArray<Html>>(model.route, {
        NewCase: () => [entryPage(model, h)],
        Rules: () => [rulesPage(model, h)],
        Desk: () => loadedDesk(model, h),
        Account: () => loadedDesk(model, h),
        Unit: () => loadedDesk(model, h),
        Reports: () => loadedDesk(model, h),
        Admin: () => loadedDesk(model, h),
        Link: () => loadedDesk(model, h),
        Report: () => loadedDesk(model, h),
        Share: () => loadedDesk(model, h),
        Names: () => loadedDesk(model, h),
        Publish: () => loadedDesk(model, h),
        Drafts: () => loadedDesk(model, h),
        Draft: () => loadedDesk(model, h),
        Inbox: () => loadedDesk(model, h),
        Notifications: () => loadedDesk(model, h),
        Comments: () => loadedDesk(model, h),
        Grid: () => loadedDesk(model, h),
        Audit: () => loadedDesk(model, h),
        Downloads: () => loadedDesk(model, h),
        Revision: () => loadedDesk(model, h),
        NotFound: () => loadedDesk(model, h),
      }),
  })

const welcomePage = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.AriaLabel('Welcome'),
      h.Class('flex flex-col items-start gap-4 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [
      h.h1(
        [
          h.Id(PAGE_HEADING_ID),
          h.Class(
            'max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
          ),
        ],
        [`Welcome to ${PRODUCT_NAME}`],
      ),
      h.p(
        [h.Class('max-w-2xl text-pretty text-xl font-light text-msf-ink')],
        [
          `Reports for ${themeOf(model).organisationName} are written, reviewed and approved here. They will appear on this page.`,
        ],
      ),
    ],
  )

const LEAVE_REASONS: Readonly<
  Record<ReturnType<typeof Report.unsavedReason>, string>
> = {
  offline:
    'You are offline. What you typed is saved when the connection returns.',
  failed: 'The last save did not work.',
  stale:
    'The working copy changed in another tab, so what you typed here is not saved.',
  saving: 'The last changes are being saved.',
}

// NOTE: Asks before the report is left with edits that are not saved (stage
// 4 review): stay, wait for the save and then go, or go without it.
const leaveDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeLeaving, {
    onNone: () => h.empty,
    onSome: leaving => {
      const reason = Report.unsavedReason(model.report)
      return h.section(
        [
          h.AriaLabel('Leave the report?'),
          h.Role('alertdialog'),
          h.Class(
            'mb-6 mt-6 flex max-w-4xl flex-col gap-3 border-2 border-msf-ink px-4 py-4',
          ),
        ],
        [
          h.h2(
            [
              h.Id(LEAVE_HEADING_ID),
              h.Tabindex(-1),
              h.Class('text-xl font-black'),
            ],
            ['This report has changes that are not saved'],
          ),
          h.p(
            [h.Class('text-pretty text-base text-msf-ink')],
            [`${LEAVE_REASONS[reason]} If you leave now, they are lost.`],
          ),
          leaving.isWaiting
            ? h.p(
                [h.Role('status'), h.Class('text-base text-msf-grey')],
                ['Waiting for the save. You leave as soon as it is done.'],
              )
            : h.empty,
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              actionButton(
                h,
                'Stay on this report',
                'Stay on this report',
                Message.ClickedStayOnReport(),
              ),
              reason === 'stale' || leaving.isWaiting
                ? h.empty
                : actionButton(
                    h,
                    'Wait for the save, then leave',
                    'Wait for the save, then leave',
                    Message.ClickedWaitToLeaveReport(),
                  ),
              actionButton(
                h,
                'Leave without saving',
                'Leave without saving',
                Message.ClickedLeaveReportUnsaved(),
              ),
            ],
          ),
        ],
      )
    },
  })

const unavailablePage = (
  title: string,
  body: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel(title),
      h.Class('flex flex-col items-start gap-4 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [
      h.h1(
        [
          h.Id(PAGE_HEADING_ID),
          h.Class(
            'max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
          ),
        ],
        [title],
      ),
      h.p(
        [h.Class('max-w-2xl text-pretty text-xl font-light text-msf-ink')],
        [body],
      ),
      h.a(
        [
          h.Href(pathOf(AppRoute.Desk())),
          h.Class(clsx('text-base', textButtonClassName)),
        ],
        ['Go to the start page'],
      ),
    ],
  )

const accountPage = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'account',
    model: model.account,
    view: Account.view,
    toParentMessage: message => Message.GotAccountMessage({ message }),
  })

const pageView = (
  model: Model,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  isTriageRoute(model.route) && modeOf(model) === 'pilot'
    ? AppRoute.guards.Desk(model.route)
      ? [welcomePage(model, h)]
      : [
          unavailablePage(
            'This page is not available',
            `The case desk is not part of this deployment of ${PRODUCT_NAME}.`,
            h,
          ),
        ]
    : AppRoute.match<ReadonlyArray<Html>>(model.route, {
        Desk: () => deskPageView(model, h),
        NewCase: () => deskPageView(model, h),
        Rules: () => deskPageView(model, h),
        Account: () => [accountPage(model, h)],
        Unit: () => [
          h.submodel({
            slotId: 'unit',
            model: model.unit,
            view: Unit.view,
            toParentMessage: message => Message.GotUnitMessage({ message }),
          }),
        ],
        Admin: () => [
          h.submodel({
            slotId: 'admin',
            model: model.admin,
            view: Admin.view,
            toParentMessage: message => Message.GotAdminMessage({ message }),
          }),
        ],
        Link: () => [welcomePage(model, h)],
        Reports: () => [
          h.submodel({
            slotId: 'reports',
            model: model.reports,
            view: Reports.view,
            toParentMessage: message => Message.GotReportsMessage({ message }),
          }),
        ],
        Report: ({ reportId }) => [
          leaveDialog(model, h),
          h.submodel({
            slotId: `report-${reportId}`,
            model: model.report,
            view: Report.view,
            toParentMessage: message => Message.GotReportMessage({ message }),
          }),
        ],
        Share: ({ reportId }) => [
          h.submodel({
            slotId: `share-${reportId}`,
            model: model.share,
            view: Share.view,
            toParentMessage: message => Message.GotShareMessage({ message }),
          }),
        ],
        Names: ({ reportId }) => [
          h.submodel({
            slotId: `names-${reportId}`,
            model: model.names,
            view: Names.view,
            toParentMessage: message => Message.GotNamesMessage({ message }),
          }),
        ],
        Publish: ({ reportId }) => [
          h.submodel({
            slotId: `publish-${reportId}`,
            model: model.publish,
            view: Publish.view,
            toParentMessage: message => Message.GotPublishMessage({ message }),
          }),
        ],
        Drafts: ({ reportId }) => [
          h.submodel({
            slotId: `drafts-${reportId}`,
            model: model.history,
            view: History.view,
            toParentMessage: message => Message.GotHistoryMessage({ message }),
          }),
        ],
        Draft: ({ reportId, draft }) => [
          h.submodel({
            slotId: `draft-${reportId}-${draft}`,
            model: model.history,
            view: History.view,
            toParentMessage: message => Message.GotHistoryMessage({ message }),
          }),
        ],
        Inbox: () => [
          h.submodel({
            slotId: 'inbox',
            model: model.inbox,
            view: Inbox.view,
            toParentMessage: message => Message.GotInboxMessage({ message }),
          }),
        ],
        Notifications: () => [
          h.submodel({
            slotId: 'notifications',
            model: model.notifications,
            view: Notifications.view,
            toParentMessage: message =>
              Message.GotNotificationsMessage({ message }),
          }),
        ],
        Comments: ({ reportId }) => [
          h.submodel({
            slotId: `comments-${reportId}`,
            model: model.comments,
            view: Comments.view,
            toParentMessage: message => Message.GotCommentsMessage({ message }),
          }),
        ],
        Grid: ({ reportId }) => [
          h.submodel({
            slotId: `grid-${reportId}`,
            model: model.grid,
            view: Grid.view,
            toParentMessage: message => Message.GotGridMessage({ message }),
          }),
        ],
        Audit: ({ reportId }) => [
          h.submodel({
            slotId: `audit-${reportId}`,
            model: model.audit,
            view: Audit.view,
            toParentMessage: message => Message.GotAuditMessage({ message }),
          }),
        ],
        Downloads: ({ reportId }) => [
          h.submodel({
            slotId: `downloads-${reportId}`,
            model: model.downloads,
            view: Downloads.view,
            toParentMessage: message =>
              Message.GotDownloadsMessage({ message }),
          }),
        ],
        Revision: ({ reportId, revision }) => [
          h.submodel({
            slotId: `rev-${reportId}-${revision}`,
            model: model.review,
            view: Review.view,
            toParentMessage: message => Message.GotReviewMessage({ message }),
          }),
        ],
        NotFound: () => [
          unavailablePage(
            'Page not found',
            'There is nothing at this address.',
            h,
          ),
        ],
      })

const linkView = (link: Link.Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'link',
    model: link,
    view: Link.view,
    toParentMessage: message => Message.GotLinkMessage({ message }),
  })

const mainView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(model.maybeLink, {
    onSome: link => [linkView(link, h)],
    onNone: () =>
      ConfigLoad.guards.Loading(model.config)
        ? [deskMessage(`Opening ${PRODUCT_NAME}`, 'Getting the settings.', h)]
        : Session.match(model.session, {
            Checking: () => [
              deskMessage(
                `Opening ${PRODUCT_NAME}`,
                'Checking your session.',
                h,
              ),
            ],
            SignedOut: () => [loginPage(model, h)],
            SignedIn: () => pageView(model, h),
          }),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: PRODUCT_NAME,
  body: h.div(
    [
      h.Id('quoroom-root'),
      h.Class(
        'min-h-dvh border-t-[6px] border-msf-red bg-msf-paper font-sans text-msf-ink',
      ),
      h.Style(themeStyle(themeOf(model))),
    ],
    [
      h.div(
        [h.Class('mx-auto max-w-6xl px-5 sm:px-10')],
        [topBar(model, h), h.main([], mainView(model, h)), footer(model, h)],
      ),
    ],
  ),
})
