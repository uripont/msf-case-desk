import { clsx } from 'clsx'
import { Array, Match, Option, Order } from 'effect'
import { type Attribute, Html, HtmlBuilder } from 'foldkit/html'

import {
  type CaseId,
  DUE_SOON_HOURS,
  type Priority,
  type SlaStatus,
  type TriagedCase,
  priorityLabel,
} from '@case-desk/domain'

import {
  type DrawnLayout,
  type HeroLayout,
  NOW_AT,
  TIMELINE_INSET_PX,
  TIMELINE_ROW_PX,
  type TimelineGeometry,
  axisPosition,
  horizonHoursOf,
  lanesOf,
  markDomId,
  neighbourOf,
  spreadLabels,
  tabStopOf,
  timelineGeometryOf,
  timelineYOf,
} from './axisLayout'
import { formatSlaCompact, formatSlaShort, formatSlaSpoken } from './format'
import { Message, type Model, visibleQueueOf } from './main'

// GEOMETRY

const HOUR_MS = 3_600_000

const percent = (value: number): string => `${value.toFixed(3)}%`

const pixels = (value: number): string => `${value.toFixed(1)}px`

const remainingHoursOf = (triaged: TriagedCase, now: number): number =>
  (triaged.result.dueAt - now) / HOUR_MS

type Anchor = 'Start' | 'Centre' | 'End'

const anchorOf = (position: number): Anchor => {
  if (position < 12) {
    return 'Start'
  }
  if (position > 82) {
    return 'End'
  }
  return 'Centre'
}

const anchorClassName = (anchor: Anchor): string =>
  Match.value(anchor).pipe(
    Match.when('Start', () => 'left-0'),
    Match.when('Centre', () => 'left-1/2 -translate-x-1/2'),
    Match.when('End', () => 'right-0'),
    Match.exhaustive,
  )

// TICKS

type Tick = {
  readonly hours: number
  readonly label: string
  readonly isWideOnly: boolean
}

const dayLabel = (hours: number, suffix: string): string => {
  const days = hours / 24
  if (!Number.isInteger(days)) {
    return `${hours} h${suffix}`
  }
  return `${days} ${days === 1 ? 'day' : 'days'}${suffix}`
}

const ticksOf = (horizonHours: number): ReadonlyArray<Tick> => [
  { hours: -24, label: dayLabel(24, ' late'), isWideOnly: true },
  ...Array.filter(
    [
      {
        hours: DUE_SOON_HOURS,
        label: `${DUE_SOON_HOURS} h`,
        isWideOnly: false,
      },
      { hours: 12, label: '12 h', isWideOnly: true },
      { hours: 24, label: dayLabel(24, ''), isWideOnly: false },
      { hours: 48, label: dayLabel(48, ''), isWideOnly: false },
    ],
    tick => tick.hours < horizonHours,
  ),
  { hours: horizonHours, label: dayLabel(horizonHours, ''), isWideOnly: false },
]

// MARKS

export const markGlyphClassName = (
  priority: Priority,
  isFastTrack: boolean,
): string => {
  if (isFastTrack) {
    return 'size-[11px] rotate-45 bg-msf-red'
  }
  return Match.value(priority).pipe(
    Match.when('P1', () => 'size-3 bg-msf-red'),
    Match.when('P2', () => 'size-2.5 bg-msf-ink'),
    Match.when('P3', () => 'size-2.5 border-[1.5px] border-msf-grey bg-white'),
    Match.exhaustive,
  )
}

const stemHeight = (priority: Priority): string =>
  Match.value(priority).pipe(
    Match.when('P1', () => '100%'),
    Match.when('P2', () => '68%'),
    Match.when('P3', () => '40%'),
    Match.exhaustive,
  )

const stemClassName = (priority: Priority): string =>
  Match.value(priority).pipe(
    Match.when('P1', () => 'w-0.5 bg-msf-red'),
    Match.when('P2', () => 'w-px bg-msf-ink'),
    Match.when('P3', () => 'w-px bg-msf-grey'),
    Match.exhaustive,
  )

const leaderClassName = (priority: Priority): string =>
  Match.value(priority).pipe(
    Match.when('P1', () => 'stroke-msf-red'),
    Match.when('P2', () => 'stroke-msf-ink'),
    Match.when('P3', () => 'stroke-msf-grey'),
    Match.exhaustive,
  )

const isOverdue = (sla: SlaStatus): boolean => sla._tag === 'Overdue'

const shortId = (caseId: string): string => caseId.replace(/^\D+-/, '')

// CONTROLS

type MarkState = {
  readonly isHighlighted: boolean
  readonly isSelected: boolean
  readonly isTabStop: boolean
}

export const markAccessibleName = (triaged: TriagedCase): string =>
  Array.join(
    [
      triaged.triageCase.id,
      priorityLabel(triaged.result.priority),
      ...(triaged.result.isFastTrack ? ['fast-track'] : []),
      formatSlaSpoken(triaged.sla),
    ],
    ', ',
  )

const isHoverPointer = (pointerType: string): boolean =>
  pointerType === 'mouse' || pointerType === 'pen'

export const hoverAttributes = (
  caseId: CaseId,
  isHighlighted: boolean,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> => [
  h.OnPointerMove((_screenX, _screenY, pointerType) =>
    isHighlighted || !isHoverPointer(pointerType)
      ? Option.none()
      : Option.some(Message.EnteredCase({ caseId })),
  ),
  h.OnPointerLeave(() =>
    isHighlighted ? Option.some(Message.LeftCase()) : Option.none(),
  ),
]

const markControlAttributes = (
  layout: DrawnLayout,
  triaged: TriagedCase,
  state: MarkState,
  orderedIds: ReadonlyArray<CaseId>,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Attribute<Message>> => {
  const caseId = triaged.triageCase.id

  return [
    h.Id(markDomId(layout, caseId)),
    h.Type('button'),
    h.Tabindex(state.isTabStop ? 0 : -1),
    h.AriaLabel(markAccessibleName(triaged)),
    h.AriaPressed(state.isSelected ? 'true' : 'false'),
    h.OnClick(Message.ClickedCase({ caseId })),
    h.OnFocus(Message.FocusedCaseMark({ caseId })),
    h.OnBlur(Message.BlurredCaseMark()),
    h.OnKeyDownFocus(key =>
      Option.map(neighbourOf(orderedIds, caseId, key), nextId => ({
        focusSelector: `#${markDomId(layout, nextId)}`,
        message: Message.FocusedCaseMark({ caseId: nextId }),
      })),
    ),
  ]
}

const markStateOf = (
  model: Model,
  caseId: CaseId,
  maybeTabStopId: Option.Option<CaseId>,
): MarkState => ({
  isHighlighted: Option.exists(
    model.maybeHighlightedCaseId,
    highlightedId => highlightedId === caseId,
  ),
  isSelected: Option.exists(
    model.maybeSelectedCaseId,
    selectedId => selectedId === caseId,
  ),
  isTabStop: Option.exists(maybeTabStopId, tabStopId => tabStopId === caseId),
})

type Counts = {
  readonly overdue: number
  readonly dueSoon: number
  readonly onTrack: number
}

type AxisInput = {
  readonly model: Model
  readonly marks: ReadonlyArray<TriagedCase>
  readonly orderedIds: ReadonlyArray<CaseId>
  readonly maybeTabStopId: Option.Option<CaseId>
  readonly counts: Counts
  readonly horizonHours: number
  readonly isResponsive: boolean
}

const transitionStyle = (
  input: AxisInput,
  name: string,
  className: string,
): Record<string, string> =>
  input.isResponsive
    ? {}
    : { viewTransitionName: name, viewTransitionClass: className }

const caseTransitionName = (caseId: CaseId): string => `case-${caseId}`

const caseLabelTransitionName = (caseId: CaseId): string =>
  `case-label-${caseId}`

// AXIS

const axisMarkLabel = (
  input: AxisInput,
  triaged: TriagedCase,
  isHighlighted: boolean,
  anchor: Anchor,
  h: HtmlBuilder<Message>,
): Html =>
  isHighlighted
    ? h.span(
        [
          h.AriaHidden(true),
          h.Class(
            clsx(
              'absolute bottom-full z-20 mb-2 whitespace-nowrap bg-msf-ink px-2 py-1 text-[13px] font-medium tabular-nums text-white',
              anchorClassName(anchor),
            ),
          ),
          h.Style(
            transitionStyle(
              input,
              caseLabelTransitionName(triaged.triageCase.id),
              'case-label',
            ),
          ),
        ],
        [`${triaged.triageCase.id} · ${formatSlaShort(triaged.sla)}`],
      )
    : h.span(
        [
          h.AriaHidden(true),
          h.Class(
            clsx(
              'absolute bottom-full left-1/2 mb-1.5 -translate-x-1/2 text-xs tabular-nums',
              isOverdue(triaged.sla)
                ? 'font-medium text-msf-red'
                : 'text-msf-grey',
            ),
          ),
          h.Style(
            transitionStyle(
              input,
              caseLabelTransitionName(triaged.triageCase.id),
              'case-label',
            ),
          ),
        ],
        [shortId(triaged.triageCase.id)],
      )

const axisMark = (
  input: AxisInput,
  triaged: TriagedCase,
  h: HtmlBuilder<Message>,
): Html => {
  const { triageCase, result } = triaged
  const position = axisPosition(
    remainingHoursOf(triaged, input.model.now),
    input.horizonHours,
  )
  const state = markStateOf(input.model, triageCase.id, input.maybeTabStopId)

  return h.keyed('div')(
    triageCase.id,
    [
      h.Class(
        clsx(
          'time-axis-mark absolute inset-y-0 w-0',
          state.isHighlighted ? 'z-20' : 'z-10',
        ),
      ),
      h.Style({ left: percent(position) }),
    ],
    [
      h.button(
        [
          ...markControlAttributes('Axis', triaged, state, input.orderedIds, h),
          ...hoverAttributes(triageCase.id, state.isHighlighted, h),
          h.Class(
            'absolute bottom-0 -left-3 flex w-6 cursor-pointer flex-col items-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-msf-ink',
          ),
          h.Style({ height: stemHeight(result.priority) }),
        ],
        [
          axisMarkLabel(
            input,
            triaged,
            state.isHighlighted,
            anchorOf(position),
            h,
          ),
          h.span([
            h.Class(
              clsx(
                'block shrink-0 transition-transform duration-200',
                markGlyphClassName(result.priority, result.isFastTrack),
                state.isHighlighted && 'scale-150',
                state.isSelected &&
                  'outline-2 outline-offset-[3px] outline-msf-ink',
              ),
            ),
            h.Style(
              transitionStyle(
                input,
                caseTransitionName(triageCase.id),
                'case-mark',
              ),
            ),
          ]),
          h.span([
            h.Class(
              clsx(
                'block flex-1 transition-opacity',
                stemClassName(result.priority),
                state.isHighlighted || state.isSelected
                  ? 'opacity-100'
                  : 'opacity-60',
              ),
            ),
          ]),
        ],
      ),
    ],
  )
}

type Zone = {
  readonly name: string
  readonly count: number
  readonly from: number
  readonly to: number
  readonly fillClassName: string
  readonly textClassName: string
  readonly transitionName: string
}

const zone = (input: AxisInput, spec: Zone, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.AriaHidden(true),
      h.Class(clsx('absolute inset-y-0', spec.fillClassName)),
      h.Style({
        left: percent(spec.from),
        width: percent(spec.to - spec.from),
      }),
    ],
    [
      h.div(
        [
          h.Class(
            clsx('flex flex-col px-3 pt-3 leading-none', spec.textClassName),
          ),
          h.Style(transitionStyle(input, spec.transitionName, 'zone-count')),
        ],
        [
          h.span(
            [h.Class('text-4xl font-black tabular-nums tracking-tight')],
            [`${spec.count}`],
          ),
          h.span(
            [h.Class('pt-1 text-sm font-medium whitespace-nowrap')],
            [spec.name],
          ),
        ],
      ),
    ],
  )

const axisTick = (
  spec: Tick,
  horizonHours: number,
  h: HtmlBuilder<Message>,
): Html => {
  const position = axisPosition(spec.hours, horizonHours)

  return h.div(
    [
      h.Class(
        clsx(
          'absolute top-0 flex-col',
          spec.isWideOnly ? 'hidden sm:flex' : 'flex',
          Match.value(anchorOf(position)).pipe(
            Match.when('Start', () => 'items-start'),
            Match.when('Centre', () => '-translate-x-1/2 items-center'),
            Match.when('End', () => '-translate-x-full items-end'),
            Match.exhaustive,
          ),
        ),
      ),
      h.Style({ left: percent(position) }),
    ],
    [
      h.span([h.Class('block h-1.5 w-px bg-msf-ink')]),
      h.span(
        [h.Class('pt-1 text-[13px] whitespace-nowrap text-msf-grey')],
        [spec.label],
      ),
    ],
  )
}

const axisView = (input: AxisInput, h: HtmlBuilder<Message>): Html => {
  const dueSoonAt = axisPosition(DUE_SOON_HOURS, input.horizonHours)

  return h.div(
    [
      h.Class(
        input.isResponsive
          ? 'relative hidden select-none sm:block'
          : 'relative select-none',
      ),
    ],
    [
      h.div(
        [h.Class('relative h-60 border-b border-msf-ink')],
        [
          zone(
            input,
            {
              name: 'Overdue',
              transitionName: 'zone-overdue',
              count: input.counts.overdue,
              from: 0,
              to: NOW_AT,
              fillClassName: 'bg-msf-red/[0.06]',
              textClassName: 'text-msf-red',
            },
            h,
          ),
          zone(
            input,
            {
              name: 'Due soon',
              transitionName: 'zone-due-soon',
              count: input.counts.dueSoon,
              from: NOW_AT,
              to: dueSoonAt,
              fillClassName: 'bg-msf-mist',
              textClassName: 'text-msf-ink',
            },
            h,
          ),
          zone(
            input,
            {
              name: 'On track',
              transitionName: 'zone-on-track',
              count: input.counts.onTrack,
              from: dueSoonAt,
              to: 100,
              fillClassName: 'bg-transparent',
              textClassName: 'text-msf-grey',
            },
            h,
          ),
          h.div(
            [
              h.AriaHidden(true),
              h.Class('absolute inset-y-0 w-0.5 -translate-x-1/2 bg-msf-red'),
              h.Style({
                left: percent(NOW_AT),
              }),
            ],
            [
              h.span([
                h.Class(
                  'time-axis-pulse absolute -bottom-1 -left-[3px] block size-2 bg-msf-red',
                ),
              ]),
            ],
          ),
          h.div(
            [
              h.Role('group'),
              h.AriaLabel('Cases on the time axis'),
              h.Class('absolute inset-x-0 bottom-0 top-[6.5rem]'),
            ],
            Array.map(Array.reverse(input.marks), triaged =>
              axisMark(input, triaged, h),
            ),
          ),
        ],
      ),
      h.div(
        [h.AriaHidden(true), h.Class('relative h-8')],
        [
          ...Array.map(ticksOf(input.horizonHours), spec =>
            axisTick(spec, input.horizonHours, h),
          ),
          h.span(
            [
              h.Class(
                'absolute top-1.5 -translate-x-1/2 bg-white px-1 text-[13px] font-bold text-msf-red',
              ),
              h.Style({
                left: percent(NOW_AT),
                ...transitionStyle(input, 'now-label', 'now-label'),
              }),
            ],
            ['Now'],
          ),
        ],
      ),
    ],
  )
}

// TIMELINE

const TIMELINE_AXIS_X_PX = 68
const TIMELINE_LABEL_X_PX = 104
const TIMELINE_LANE_PX = 10
const TIMELINE_LANE_COUNT = 3
const TIMELINE_GLYPH_GAP_PX = 13
const TIMELINE_LEADER_WIDTH_PX = TIMELINE_LABEL_X_PX - TIMELINE_AXIS_X_PX

type PlacedMark = {
  readonly triaged: TriagedCase
  readonly markY: number
  readonly markX: number
  readonly labelY: number
}

const zoneCount = (
  input: AxisInput,
  transitionName: string,
  name: string,
  count: number,
  cellClassName: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class(
        clsx(
          'flex flex-col gap-1 px-3 pb-2.5 pt-2 leading-none',
          cellClassName,
        ),
      ),
      h.Style(transitionStyle(input, transitionName, 'zone-count')),
    ],
    [
      h.span(
        [h.Class('text-[2rem] font-black tabular-nums tracking-tight')],
        [`${count}`],
      ),
      h.span([h.Class('text-sm font-medium whitespace-nowrap')], [name]),
    ],
  )

const timelineTick = (
  label: string,
  y: number,
  h: HtmlBuilder<Message>,
): Html =>
  h.div(
    [
      h.Class('absolute left-0 flex -translate-y-1/2 items-center'),
      h.Style({ top: pixels(y), width: pixels(TIMELINE_AXIS_X_PX) }),
    ],
    [
      h.span(
        [
          h.Class(
            'flex-1 pr-2 text-right text-xs whitespace-nowrap text-msf-grey',
          ),
        ],
        [label],
      ),
      h.span([h.Class('block h-px w-1.5 bg-msf-ink')]),
    ],
  )

const timelineLeader = (placed: PlacedMark, h: HtmlBuilder<Message>): Html => {
  const startX = placed.markX - TIMELINE_AXIS_X_PX
  const bendX = startX + 6

  return h.path([
    h.Class(
      clsx(
        'time-axis-leader fill-none',
        leaderClassName(placed.triaged.result.priority),
      ),
    ),
    h.StrokeWidth(placed.triaged.result.priority === 'P1' ? '1.5' : '1'),
    h.D(
      `M${startX} ${placed.markY.toFixed(1)} H${bendX} L${TIMELINE_LEADER_WIDTH_PX - 10} ${placed.labelY.toFixed(1)} H${TIMELINE_LEADER_WIDTH_PX}`,
    ),
  ])
}

const timelineGlyph = (
  input: AxisInput,
  placed: PlacedMark,
  h: HtmlBuilder<Message>,
): Html => {
  const { triageCase, result } = placed.triaged
  const state = markStateOf(input.model, triageCase.id, Option.none())

  return h.keyed('span')(
    triageCase.id,
    [
      h.Class(
        clsx(
          'time-axis-slide absolute flex size-0 items-center justify-center',
          state.isHighlighted ? 'z-20' : 'z-10',
        ),
      ),
      h.Style({ top: pixels(placed.markY), left: pixels(placed.markX) }),
    ],
    [
      h.span([
        h.Class(
          clsx(
            'block shrink-0 transition-transform duration-200',
            markGlyphClassName(result.priority, result.isFastTrack),
            state.isHighlighted && 'scale-150',
          ),
        ),
        h.Style(
          transitionStyle(
            input,
            caseTransitionName(triageCase.id),
            'case-mark',
          ),
        ),
      ]),
    ],
  )
}

const timelineSlaClassName = (sla: SlaStatus): string =>
  Match.value(sla).pipe(
    Match.tagsExhaustive({
      OnTrack: () => 'text-msf-grey',
      DueSoon: () => 'font-medium text-msf-ink',
      Overdue: () => 'font-medium text-msf-red',
    }),
  )

const timelineLabel = (
  input: AxisInput,
  placed: PlacedMark,
  h: HtmlBuilder<Message>,
): Html => {
  const { triageCase, result, sla } = placed.triaged
  const state = markStateOf(input.model, triageCase.id, input.maybeTabStopId)

  return h.keyed('button')(
    triageCase.id,
    [
      ...markControlAttributes(
        'Timeline',
        placed.triaged,
        state,
        input.orderedIds,
        h,
      ),
      h.Class(
        clsx(
          'time-axis-slide absolute inset-x-0 flex h-11 -translate-y-1/2 cursor-pointer items-center gap-x-2 border-l-[3px] pr-1 pl-2 text-left text-sm tabular-nums min-[360px]:gap-x-3 min-[360px]:pl-2.5 min-[360px]:text-[15px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-msf-ink',
          state.isSelected ? 'border-msf-red' : 'border-transparent',
          state.isHighlighted
            ? 'bg-msf-ink text-white'
            : state.isSelected
              ? 'bg-msf-mist'
              : 'bg-white',
        ),
      ),
      h.Style({
        top: pixels(placed.labelY),
        ...transitionStyle(
          input,
          caseLabelTransitionName(triageCase.id),
          'case-label',
        ),
      }),
    ],
    [
      h.span([h.Class('font-medium whitespace-nowrap')], [triageCase.id]),
      h.span(
        [
          h.Class(
            clsx(
              'min-w-0 truncate',
              state.isHighlighted ? 'text-white' : timelineSlaClassName(sla),
            ),
          ),
        ],
        [formatSlaCompact(sla)],
      ),
      result.isFastTrack
        ? h.span(
            [
              h.Class(
                clsx(
                  'ml-auto hidden text-[13px] font-medium whitespace-nowrap min-[400px]:inline',
                  state.isHighlighted ? 'text-white' : 'text-msf-red',
                ),
              ),
            ],
            ['Fast-track'],
          )
        : h.empty,
    ],
  )
}

const placeMarks = (
  input: AxisInput,
  geometry: TimelineGeometry,
): ReadonlyArray<PlacedMark> => {
  const markYs = Array.map(input.marks, triaged =>
    timelineYOf(
      remainingHoursOf(triaged, input.model.now),
      input.horizonHours,
      geometry,
    ),
  )
  const overdueCount = input.counts.overdue
  const labelYs = [
    ...spreadLabels(
      Array.take(markYs, overdueCount),
      TIMELINE_ROW_PX,
      TIMELINE_INSET_PX + TIMELINE_ROW_PX / 2,
      geometry.nowY - TIMELINE_ROW_PX / 2,
    ),
    ...spreadLabels(
      Array.drop(markYs, overdueCount),
      TIMELINE_ROW_PX,
      geometry.nowY + TIMELINE_ROW_PX / 2,
      geometry.nowY + geometry.aheadSpan - TIMELINE_ROW_PX / 2,
    ),
  ]
  const lanes = lanesOf(markYs, TIMELINE_GLYPH_GAP_PX, TIMELINE_LANE_COUNT)

  return Array.map(input.marks, (triaged, index) => ({
    triaged,
    markY: Option.getOrElse(Array.get(markYs, index), () => 0),
    markX:
      TIMELINE_AXIS_X_PX +
      0.5 +
      TIMELINE_LANE_PX * Option.getOrElse(Array.get(lanes, index), () => 0),
    labelY: Option.getOrElse(Array.get(labelYs, index), () => 0),
  }))
}

const timelineView = (input: AxisInput, h: HtmlBuilder<Message>): Html => {
  const geometry = timelineGeometryOf(
    input.counts.overdue,
    input.marks.length - input.counts.overdue,
  )
  const yOf = (hours: number): number =>
    timelineYOf(hours, input.horizonHours, geometry)
  const dueSoonY = yOf(DUE_SOON_HOURS)
  const placedMarks = placeMarks(input, geometry)

  return h.div(
    [
      h.Class(
        input.isResponsive
          ? 'flex flex-col gap-5 select-none sm:hidden'
          : 'flex flex-col gap-5 select-none',
      ),
    ],
    [
      h.div(
        [h.AriaHidden(true), h.Class('grid grid-cols-3')],
        [
          zoneCount(
            input,
            'zone-overdue',
            'Overdue',
            input.counts.overdue,
            'bg-msf-red/[0.06] text-msf-red',
            h,
          ),
          zoneCount(
            input,
            'zone-due-soon',
            'Due soon',
            input.counts.dueSoon,
            'bg-msf-mist text-msf-ink',
            h,
          ),
          zoneCount(
            input,
            'zone-on-track',
            'On track',
            input.counts.onTrack,
            'border border-msf-line text-msf-grey',
            h,
          ),
        ],
      ),
      h.div(
        [h.Class('relative'), h.Style({ height: pixels(geometry.height) })],
        [
          h.div([
            h.AriaHidden(true),
            h.Class('absolute top-0 left-0 bg-msf-red/[0.06]'),
            h.Style({
              height: pixels(geometry.nowY),
              width: pixels(TIMELINE_LABEL_X_PX),
            }),
          ]),
          h.div([
            h.AriaHidden(true),
            h.Class('absolute left-0 bg-msf-mist'),
            h.Style({
              top: pixels(geometry.nowY),
              height: pixels(dueSoonY - geometry.nowY),
              width: pixels(TIMELINE_LABEL_X_PX),
            }),
          ]),
          h.div([
            h.AriaHidden(true),
            h.Class('absolute inset-y-0 w-px bg-msf-ink'),
            h.Style({ left: pixels(TIMELINE_AXIS_X_PX) }),
          ]),
          h.div(
            [h.AriaHidden(true)],
            Array.map(ticksOf(input.horizonHours), spec =>
              timelineTick(spec.label, yOf(spec.hours), h),
            ),
          ),
          h.div(
            [
              h.AriaHidden(true),
              h.Class('absolute inset-x-0 h-0.5 -translate-y-1/2 bg-msf-red'),
              h.Style({
                top: pixels(geometry.nowY),
              }),
            ],
            [
              h.span(
                [
                  h.Class(
                    'absolute bottom-1 left-0 pr-2 text-right text-[13px] leading-none font-bold text-msf-red',
                  ),
                  h.Style({
                    width: pixels(TIMELINE_AXIS_X_PX),
                    ...transitionStyle(input, 'now-label', 'now-label'),
                  }),
                ],
                ['Now'],
              ),
              h.span([
                h.Class(
                  'time-axis-pulse absolute top-1/2 block size-2 -translate-x-1/2 -translate-y-1/2 bg-msf-red',
                ),
                h.Style({ left: pixels(TIMELINE_AXIS_X_PX + 0.5) }),
              ]),
            ],
          ),
          h.svg(
            [
              h.AriaHidden(true),
              h.Class('absolute top-0 overflow-visible'),
              h.Style({ left: pixels(TIMELINE_AXIS_X_PX) }),
              h.Width(`${TIMELINE_LEADER_WIDTH_PX}`),
              h.Height(`${geometry.height}`),
              h.ViewBox(`0 0 ${TIMELINE_LEADER_WIDTH_PX} ${geometry.height}`),
            ],
            Array.map(placedMarks, placed => timelineLeader(placed, h)),
          ),
          h.div(
            [h.AriaHidden(true)],
            Array.map(placedMarks, placed => timelineGlyph(input, placed, h)),
          ),
          h.div(
            [
              h.Role('group'),
              h.AriaLabel('Cases on the timeline'),
              h.Class('absolute inset-y-0 right-0'),
              h.Style({ left: pixels(TIMELINE_LABEL_X_PX) }),
            ],
            Array.map(placedMarks, placed => timelineLabel(input, placed, h)),
          ),
        ],
      ),
    ],
  )
}

// LEGEND

const legendItem = (
  glyphClassName: string,
  label: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.span(
    [h.Class('inline-flex items-center gap-2')],
    [h.span([h.Class(clsx('block', glyphClassName))]), h.span([], [label])],
  )

const legend = (layout: HeroLayout, h: HtmlBuilder<Message>): Html =>
  h.div(
    [
      h.AriaHidden(true),
      h.Class(
        'flex flex-wrap items-center justify-between gap-x-8 gap-y-2 pt-2 text-[13px] text-msf-grey',
      ),
    ],
    [
      h.div(
        [h.Class('flex flex-wrap items-center gap-x-5 gap-y-2')],
        [
          legendItem(markGlyphClassName('P1', true), 'Fast-track', h),
          legendItem(markGlyphClassName('P1', false), 'Urgent', h),
          legendItem(markGlyphClassName('P2', false), 'Medium', h),
          legendItem(markGlyphClassName('P3', false), 'Standard', h),
        ],
      ),
      h.span(
        [
          h.Class(
            Match.value(layout).pipe(
              Match.when('Responsive', () => 'hidden sm:inline'),
              Match.when('Axis', () => 'inline'),
              Match.when('Timeline', () => 'hidden'),
              Match.exhaustive,
            ),
          ),
        ],
        ['Time left to assess each case. The scale widens near now.'],
      ),
      h.span(
        [
          h.Class(
            Match.value(layout).pipe(
              Match.when('Responsive', () => 'text-pretty sm:hidden'),
              Match.when('Axis', () => 'hidden'),
              Match.when('Timeline', () => 'text-pretty'),
              Match.exhaustive,
            ),
          ),
        ],
        [
          'Time runs down the page. The scale widens near now. Labels are spaced out to stay readable; each line points to the true time.',
        ],
      ),
    ],
  )

// VIEW

const soonestDueFirst = Order.mapInput(
  Order.Number,
  (triaged: TriagedCase) => triaged.result.dueAt,
)

const countWhere = (
  queue: ReadonlyArray<TriagedCase>,
  tag: SlaStatus['_tag'],
): number => Array.filter(queue, triaged => triaged.sla._tag === tag).length

export const timeAxis = (model: Model, h: HtmlBuilder<Message>): Html => {
  const queue = visibleQueueOf(model)
  const marks = Array.sort(queue, soonestDueFirst)
  const orderedIds = Array.map(marks, triaged => triaged.triageCase.id)
  const input: AxisInput = {
    model,
    marks,
    orderedIds,
    maybeTabStopId: tabStopOf(
      orderedIds,
      model.maybeHighlightedCaseId,
      model.maybeSelectedCaseId,
    ),
    counts: {
      overdue: countWhere(queue, 'Overdue'),
      dueSoon: countWhere(queue, 'DueSoon'),
      onTrack: countWhere(queue, 'OnTrack'),
    },
    horizonHours: horizonHoursOf(model.rules),
    isResponsive: model.heroLayout === 'Responsive',
  }

  return h.figure(
    [h.Class('m-0 flex flex-col gap-3 pt-6 md:pt-10')],
    [
      h.figcaption(
        [h.Class('sr-only')],
        [
          `Time left before each case should be assessed: ${input.counts.overdue} overdue, ${input.counts.dueSoon} due within ${DUE_SOON_HOURS} hours, ${input.counts.onTrack} on track. Use the arrow keys to move between the cases on the axis. Every case is also listed below with its time left.`,
        ],
      ),
      ...Match.value(model.heroLayout).pipe(
        Match.when('Responsive', () => [
          axisView(input, h),
          timelineView(input, h),
        ]),
        Match.when('Axis', () => [axisView(input, h)]),
        Match.when('Timeline', () => [timelineView(input, h)]),
        Match.exhaustive,
      ),
      legend(model.heroLayout, h),
    ],
  )
}
