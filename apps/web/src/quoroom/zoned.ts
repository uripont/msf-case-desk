import { Array, Option, pipe } from 'effect'

// NOTE: Deadlines are a date, a time and a time zone typed by the author, and
// stored as UTC milliseconds with that zone (`{ at, timeZone }`). These pure
// functions turn one into the other with `Intl` and show a deadline in its own
// zone. No clock is read here: the time now is always a parameter.

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_TEXT = /^(\d{2}):(\d{2})$/
const MINUTE_MS = 60_000

export const isKnownZone = (zone: string): boolean => {
  if (zone === '') {
    return false
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

type Parts = Readonly<{
  year: number
  month: number
  day: number
  hour: number
  minute: number
}>

// NOTE: a time `Intl` cannot format (out of range) reads as the epoch, so
// nothing here throws on a stored value.
const formatParts = (epochMs: number, zone: string) => {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(epochMs)
  } catch {
    return []
  }
}

const partsIn = (epochMs: number, zone: string): Parts => {
  const found = formatParts(epochMs, zone)
  const part = (type: string): number =>
    pipe(
      Array.findFirst(found, entry => entry.type === type),
      Option.match({
        onNone: () => 0,
        onSome: entry => Number(entry.value),
      }),
    )
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour'),
    minute: part('minute'),
  }
}

const offsetMinutes = (epochMs: number, zone: string): number => {
  const parts = partsIn(epochMs, zone)
  const wall = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
  )
  const minuteStart = Math.floor(epochMs / MINUTE_MS) * MINUTE_MS
  return (wall - minuteStart) / MINUTE_MS
}

const two = (value: number): string => String(value).padStart(2, '0')

export const dateTextIn = (epochMs: number, zone: string): string => {
  const parts = partsIn(epochMs, zone)
  return `${parts.year}-${two(parts.month)}-${two(parts.day)}`
}

// NOTE: The instant at which the wall clock of `zone` shows `date` and
// `time`. None for text that is not a real date and time, or an unknown zone.
export const zonedTimeToEpoch = (
  date: string,
  time: string,
  zone: string,
): Option.Option<number> => {
  const dateMatch = DATE_TEXT.exec(date)
  const timeMatch = TIME_TEXT.exec(time)
  if (dateMatch === null || timeMatch === null || !isKnownZone(zone)) {
    return Option.none()
  }
  const [year, month, day] = [dateMatch[1], dateMatch[2], dateMatch[3]].map(
    Number,
  )
  const [hour, minute] = [timeMatch[1], timeMatch[2]].map(Number)
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59
  ) {
    return Option.none()
  }
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  if (new Date(wall).getUTCDate() !== day) {
    return Option.none()
  }
  const first = wall - offsetMinutes(wall, zone) * MINUTE_MS
  return Option.some(wall - offsetMinutes(first, zone) * MINUTE_MS)
}

const city = (zone: string): string =>
  (zone.split('/').pop() ?? zone).replaceAll('_', ' ')

// NOTE: "24 Nov, 18:00 Madrid time": the deadline on the wall clock of its own
// zone, which is what a reader outside that zone needs to convert from.
export const deadlineText = (epochMs: number, zone: string): string => {
  try {
    return isKnownZone(zone)
      ? `${new Intl.DateTimeFormat('en-GB', {
          timeZone: zone,
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(epochMs)} ${city(zone)} time`
      : `${new Date(epochMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
  } catch {
    return 'an unknown time'
  }
}

export const countdownText = (epochMs: number, nowMs: number): string => {
  const remaining = epochMs - nowMs
  if (remaining <= 0) {
    return 'The deadline has passed'
  }
  const totalMinutes = Math.max(1, Math.ceil(remaining / MINUTE_MS))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  return days > 0
    ? `${days}d ${hours}h left`
    : hours > 0
      ? `${hours}h ${minutes}m left`
      : `${minutes}m left`
}

export const COMMON_ZONES: ReadonlyArray<string> = [
  'UTC',
  'Europe/Madrid',
  'Europe/Paris',
  'Europe/London',
  'Europe/Amsterdam',
  'Africa/Nairobi',
  'Africa/Kinshasa',
  'Africa/Johannesburg',
  'Asia/Beirut',
  'Asia/Kolkata',
  'Asia/Bangkok',
  'Asia/Tokyo',
  'America/New_York',
  'America/Bogota',
]

export const zoneChoices = (current: string): ReadonlyArray<string> =>
  Array.contains(COMMON_ZONES, current) || current === ''
    ? COMMON_ZONES
    : [current, ...COMMON_ZONES]
