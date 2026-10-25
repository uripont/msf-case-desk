import { clsx } from 'clsx'
import { Array, Match, Option } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'

import {
  PRIORITIES,
  type Priority,
  type SlaStatus,
  type TriagedCase,
  describeReason,
  priorityLabel,
} from '@case-desk/domain'

import { BRAND } from './brand'
import { formatInstant, formatSla, formatSlaShort, humanise } from './format'
import {
  CENTRE_FILTERS,
  type CentreFilter,
  Message,
  type Model,
  dueSoonCountOf,
  maybeSelectedOf,
  overdueCountOf,
  visibleQueueOf,
} from './main'
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

const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-msf-ink'

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

const textButtonClassName = clsx(
  'cursor-pointer text-msf-ink underline decoration-msf-line decoration-1 underline-offset-[6px] transition-colors hover:decoration-msf-red',
  focusRing,
)

const outlineButtonClassName = clsx(
  'inline-flex h-10 min-w-14 cursor-pointer items-center justify-center border border-msf-line px-3 tabular-nums text-msf-ink transition-colors hover:border-msf-red hover:text-msf-red active:bg-msf-mist',
  focusRing,
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

const wordmark = (h: HtmlBuilder<Message>): Html =>
  h.p(
    [h.Class('pb-2 text-xl font-black tracking-tight text-msf-black md:pb-3')],
    [BRAND.productName],
  )

const topBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [
      h.Class(
        'flex flex-col gap-x-12 border-b border-msf-line pt-5 md:flex-row md:items-end md:justify-between md:pt-6',
      ),
    ],
    [
      wordmark(h),
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
      ),
    ],
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
              `${rows.length} ${plural(rows.length, 'case', 'cases')}, assess within ${model.rules.targetHours[priority]} hours`,
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
        h.p(
          [
            h.Class(
              'border-t-2 border-msf-ink pt-5 text-2xl font-light text-msf-grey',
            ),
          ],
          ['No cases for this centre.'],
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

const clockButton = (
  label: string,
  message: Message,
  h: HtmlBuilder<Message>,
): Html =>
  h.button([h.Class(outlineButtonClassName), h.OnClick(message)], [label])

const demoControls = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel('Simulated clock'),
      h.Class(
        'flex flex-col gap-4 border-l-2 border-msf-line pl-5 md:flex-row md:items-center md:justify-between',
      ),
    ],
    [
      h.p(
        [h.Class('flex flex-wrap items-baseline gap-x-3 text-base')],
        [
          h.span([h.Class('text-msf-grey')], ['Simulated time']),
          h.span(
            [h.Class('font-medium tabular-nums text-msf-ink')],
            [formatInstant(model.now)],
          ),
        ],
      ),
      h.div(
        [h.Class('flex flex-wrap items-center gap-2')],
        [
          clockButton('+1 h', Message.ClickedAdvanceClock({ hours: 1 }), h),
          clockButton('+6 h', Message.ClickedAdvanceClock({ hours: 6 }), h),
          clockButton('+24 h', Message.ClickedAdvanceClock({ hours: 24 }), h),
          h.button(
            [
              h.Class(clsx('ml-3 text-base', textButtonClassName)),
              h.OnClick(Message.ClickedResetClock()),
            ],
            ['Reset'],
          ),
        ],
      ),
    ],
  )

const footer = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.footer(
    [
      h.Class(
        'mt-24 flex flex-col gap-6 border-t border-msf-line pb-12 pt-8 md:mt-32',
      ),
    ],
    [
      Option.match(BRAND.maybeLogo, {
        onNone: () => h.empty,
        onSome: logo =>
          h.img([
            h.Src(logo.src),
            h.Alt(logo.alt),
            h.Class('block h-14 w-auto self-start'),
          ]),
      }),
      h.p(
        [h.Class('max-w-3xl text-base leading-relaxed text-msf-ink')],
        [
          'A prototype for Metges Sense Fronteres, developed at Universitat Pompeu Fabra as part of our Project Management course.',
        ],
      ),
      h.button(
        [
          h.Class(clsx('self-start text-sm', textButtonClassName)),
          h.AriaExpanded(model.isDemoControlsOpen),
          h.OnClick(Message.ClickedToggleDemoControls()),
        ],
        ['Demo controls'],
      ),
      model.isDemoControlsOpen ? demoControls(model, h) : h.empty,
    ],
  )

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: BRAND.productName,
  body: h.div(
    [h.Class('mx-auto max-w-6xl px-5 sm:px-10')],
    [
      topBar(model, h),
      h.main(
        [],
        [
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
                onNone: () =>
                  emptyDetail(movingBlockStyle(model, 'case-detail'), h),
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
        ],
      ),
      footer(model, h),
    ],
  ),
})
