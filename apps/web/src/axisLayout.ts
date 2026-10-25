import { Array, Match, Option, Order, Schema, pipe } from 'effect'

import { type TriageRules } from '@case-desk/domain'

// LAYOUT

export const HeroLayout = Schema.Literals(['Responsive', 'Axis', 'Timeline'])
export type HeroLayout = typeof HeroLayout.Type

export type DrawnLayout = 'Axis' | 'Timeline'

export const NARROW_VIEWPORT_QUERY = '(max-width: 639.98px)'
export const LAYOUT_SETTLE_MS = 280

export const heroLayoutForViewport = (isNarrow: boolean): DrawnLayout =>
  isNarrow ? 'Timeline' : 'Axis'

export const isAnimatedLayoutChange = (
  previous: HeroLayout,
  next: HeroLayout,
): boolean => previous !== 'Responsive' && previous !== next

export const markDomId = (layout: DrawnLayout, caseId: string): string =>
  Match.value(layout).pipe(
    Match.when('Axis', () => `axis-case-${caseId}`),
    Match.when('Timeline', () => `timeline-case-${caseId}`),
    Match.exhaustive,
  )

// SCALE

export const NOW_AT = 22
export const LATE_SPAN_HOURS = 48

export const horizonHoursOf = (rules: TriageRules): number =>
  Math.max(
    rules.fastTrackHours,
    rules.targetHours.P1,
    rules.targetHours.P2,
    rules.targetHours.P3,
  )

const easedShare = (hours: number, span: number): number =>
  Math.sqrt(Math.min(Math.max(hours, 0), span) / span)

export const axisPosition = (
  remainingHours: number,
  horizonHours: number,
): number =>
  remainingHours >= 0
    ? NOW_AT + (100 - NOW_AT) * easedShare(remainingHours, horizonHours)
    : NOW_AT - NOW_AT * easedShare(-remainingHours, LATE_SPAN_HOURS)

// TIMELINE

export const TIMELINE_ROW_PX = 48
export const TIMELINE_INSET_PX = 16
export const TIMELINE_LATE_MIN_PX = 72
export const TIMELINE_AHEAD_MIN_PX = 336

export type TimelineGeometry = {
  readonly height: number
  readonly nowY: number
  readonly lateSpan: number
  readonly aheadSpan: number
}

export const timelineGeometryOf = (
  overdueCount: number,
  aheadCount: number,
): TimelineGeometry => {
  const lateSpan = Math.max(
    TIMELINE_LATE_MIN_PX,
    overdueCount * TIMELINE_ROW_PX,
  )
  const aheadSpan = Math.max(
    TIMELINE_AHEAD_MIN_PX,
    aheadCount * TIMELINE_ROW_PX,
  )
  const nowY = TIMELINE_INSET_PX + lateSpan

  return {
    height: nowY + aheadSpan + TIMELINE_INSET_PX,
    nowY,
    lateSpan,
    aheadSpan,
  }
}

export const timelineYOf = (
  remainingHours: number,
  horizonHours: number,
  geometry: TimelineGeometry,
): number =>
  remainingHours >= 0
    ? geometry.nowY +
      geometry.aheadSpan * easedShare(remainingHours, horizonHours)
    : geometry.nowY -
      geometry.lateSpan * easedShare(-remainingHours, LATE_SPAN_HOURS)

export const lanesOf = (
  positions: ReadonlyArray<number>,
  minGap: number,
  laneCount: number,
): ReadonlyArray<number> => {
  const initialLastPositions: ReadonlyArray<number> = Array.makeBy(
    laneCount,
    () => Number.NEGATIVE_INFINITY,
  )
  const noLanes: ReadonlyArray<number> = []

  return Array.reduce(
    positions,
    { lastPositions: initialLastPositions, lanes: noLanes },
    ({ lastPositions, lanes }, position) => {
      const lane = pipe(
        Array.findFirstIndex(
          lastPositions,
          lastPosition => position - lastPosition >= minGap,
        ),
        Option.getOrElse(() => {
          const earliest = Math.min(...lastPositions)
          return Math.max(0, lastPositions.indexOf(earliest))
        }),
      )
      return {
        lastPositions: Array.map(lastPositions, (lastPosition, index) =>
          index === lane ? position : lastPosition,
        ),
        lanes: Array.append(lanes, lane),
      }
    },
  ).lanes
}

type Cluster = {
  readonly count: number
  readonly desiredSum: number
  readonly start: number
}

const clusterStart = (
  count: number,
  desiredSum: number,
  gap: number,
  min: number,
  max: number,
): number => {
  const span = (count - 1) * gap
  const centred = desiredSum / count - span / 2
  return Math.min(Math.max(centred, min), Math.max(max - span, min))
}

const mergeOverlapping = (
  clusters: ReadonlyArray<Cluster>,
  gap: number,
  min: number,
  max: number,
): ReadonlyArray<Cluster> =>
  Option.match(
    Option.all([
      Array.get(clusters, clusters.length - 2),
      Array.last(clusters),
    ]),
    {
      onNone: () => clusters,
      onSome: ([previous, latest]) => {
        if (previous.start + previous.count * gap <= latest.start) {
          return clusters
        }
        const count = previous.count + latest.count
        const desiredSum = previous.desiredSum + latest.desiredSum
        return mergeOverlapping(
          Array.append(Array.dropRight(clusters, 2), {
            count,
            desiredSum,
            start: clusterStart(count, desiredSum, gap, min, max),
          }),
          gap,
          min,
          max,
        )
      },
    },
  )

export const spreadLabels = (
  desired: ReadonlyArray<number>,
  gap: number,
  min: number,
  max: number,
): ReadonlyArray<number> => {
  const sorted = Array.sort(desired, Order.Number)
  if ((sorted.length - 1) * gap > max - min) {
    return Array.makeBy(sorted.length, index =>
      sorted.length === 1
        ? min
        : min + (index * (max - min)) / (sorted.length - 1),
    )
  }
  const noClusters: ReadonlyArray<Cluster> = []
  return pipe(
    Array.reduce(sorted, noClusters, (clusters, centre) =>
      mergeOverlapping(
        Array.append(clusters, {
          count: 1,
          desiredSum: centre,
          start: clusterStart(1, centre, gap, min, max),
        }),
        gap,
        min,
        max,
      ),
    ),
    Array.flatMap(cluster =>
      Array.makeBy(cluster.count, index => cluster.start + index * gap),
    ),
  )
}

// KEYBOARD

export const tabStopOf = <Id>(
  orderedIds: ReadonlyArray<Id>,
  maybeHighlightedId: Option.Option<Id>,
  maybeSelectedId: Option.Option<Id>,
): Option.Option<Id> => {
  const isListed = (id: Id): boolean => Array.contains(orderedIds, id)
  return pipe(
    Option.filter(maybeHighlightedId, isListed),
    Option.orElse(() => Option.filter(maybeSelectedId, isListed)),
    Option.orElse(() => Array.head(orderedIds)),
  )
}

export const neighbourOf = <Id>(
  orderedIds: ReadonlyArray<Id>,
  currentId: Id,
  key: string,
): Option.Option<Id> =>
  pipe(
    Array.findFirstIndex(orderedIds, id => id === currentId),
    Option.flatMap(index =>
      Match.value(key).pipe(
        Match.whenOr('ArrowRight', 'ArrowDown', () =>
          Array.get(orderedIds, index + 1),
        ),
        Match.whenOr('ArrowLeft', 'ArrowUp', () =>
          index === 0 ? Option.none() : Array.get(orderedIds, index - 1),
        ),
        Match.when('Home', () => Array.head(orderedIds)),
        Match.when('End', () => Array.last(orderedIds)),
        Match.orElse(() => Option.none()),
      ),
    ),
  )
