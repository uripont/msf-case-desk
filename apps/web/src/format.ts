import { Match } from 'effect'

import { type SlaStatus } from '@case-desk/domain'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

export const formatDuration = (milliseconds: number): string => {
  const totalMinutes = Math.max(0, Math.round(milliseconds / MINUTE_MS))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

export const formatSla = (sla: SlaStatus): string =>
  Match.value(sla).pipe(
    Match.tagsExhaustive({
      OnTrack: ({ remainingMs }) => `Due in ${formatDuration(remainingMs)}`,
      DueSoon: ({ remainingMs }) =>
        `Due soon, ${formatDuration(remainingMs)} left`,
      Overdue: ({ overdueMs }) => `Overdue by ${formatDuration(overdueMs)}`,
    }),
  )

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  hour12: false,
})

export const formatSlaShort = (sla: SlaStatus): string =>
  Match.value(sla).pipe(
    Match.tagsExhaustive({
      OnTrack: ({ remainingMs }) => `${formatDuration(remainingMs)} left`,
      DueSoon: ({ remainingMs }) => `${formatDuration(remainingMs)} left`,
      Overdue: ({ overdueMs }) => `Overdue ${formatDuration(overdueMs)}`,
    }),
  )

export const formatSlaCompact = (sla: SlaStatus): string =>
  Match.value(sla).pipe(
    Match.tagsExhaustive({
      OnTrack: ({ remainingMs }) => `${formatDuration(remainingMs)} left`,
      DueSoon: ({ remainingMs }) => `${formatDuration(remainingMs)} left`,
      Overdue: ({ overdueMs }) => `${formatDuration(overdueMs)} late`,
    }),
  )

export const formatInstant = (epochMs: number): string =>
  `${dateTimeFormat.format(new Date(epochMs))} UTC`

export const hoursToMs = (hours: number): number => hours * HOUR_MS

export const humanise = (identifier: string): string =>
  identifier.replace(/([a-z])([A-Z])/g, '$1 $2')

const unitPhrase = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? '' : 's'}`

export const spokenDuration = (milliseconds: number): string => {
  const totalMinutes = Math.max(0, Math.round(milliseconds / MINUTE_MS))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60

  if (days > 0) {
    return hours > 0
      ? `${unitPhrase(days, 'day')} ${unitPhrase(hours, 'hour')}`
      : unitPhrase(days, 'day')
  }
  if (hours > 0) {
    return minutes > 0
      ? `${unitPhrase(hours, 'hour')} ${unitPhrase(minutes, 'minute')}`
      : unitPhrase(hours, 'hour')
  }
  return unitPhrase(minutes, 'minute')
}

export const formatSlaSpoken = (sla: SlaStatus): string =>
  Match.value(sla).pipe(
    Match.tagsExhaustive({
      OnTrack: ({ remainingMs }) => `${spokenDuration(remainingMs)} left`,
      DueSoon: ({ remainingMs }) =>
        `due soon, ${spokenDuration(remainingMs)} left`,
      Overdue: ({ overdueMs }) => `overdue by ${spokenDuration(overdueMs)}`,
    }),
  )
