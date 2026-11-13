import { Array, Option } from 'effect'

import {
  IMAGE_CHUNK_BYTES,
  IMAGE_MAX_BYTES,
  IMAGE_MAX_SIDE,
  IMAGE_REPORT_LIMIT_BYTES,
} from '@case-desk/domain'

// NOTE: The pure part of image handling in the browser (stage 4d): how large
// an image may be, what format it is saved in, whether a result is accepted,
// how it is cut into chunks and what a refusal says. It touches no browser
// API, so it is unit tested. The parts that do (`encode.ts`, `upload.ts`) only
// carry out what is decided here.

export type Size = Readonly<{ width: number; height: number }>

// NOTE: The size within `max` pixels on the longest side, in the same
// proportions. An image already within the limit keeps its size (never
// enlarged); each side is at least one pixel.
export const fitWithin = (
  size: Size,
  max: number = IMAGE_MAX_SIDE,
): Size => {
  const longest = Math.max(size.width, size.height)
  if (longest <= max) {
    return { width: Math.max(1, size.width), height: Math.max(1, size.height) }
  }
  const scale = max / longest
  return {
    width: Math.max(1, Math.min(max, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(max, Math.round(size.height * scale))),
  }
}

// NOTE: True when any pixel is not fully opaque. `rgba` is the pixel data of a
// canvas (four bytes a pixel, alpha last). A fully opaque picture is saved as
// JPEG, anything with transparency as PNG so the transparency survives.
export const hasTransparency = (rgba: ArrayLike<number>): boolean => {
  const last = rgba.length - 1
  // NOTE: stepping through the alpha bytes; a plain loop, as this runs over
  // millions of bytes.
  for (let at = 3; at <= last; at += 4) {
    if ((rgba[at] ?? 255) < 255) {
      return true
    }
  }
  return false
}

export type OutputFormat = Readonly<{
  mime: 'image/jpeg' | 'image/png'
  // NOTE: Encoder qualities to try in order; PNG has none.
  qualities: ReadonlyArray<number>
}>

export const JPEG_QUALITIES: ReadonlyArray<number> = [0.85, 0.7]

export const formatFor = (isTransparent: boolean): OutputFormat =>
  isTransparent
    ? { mime: 'image/png', qualities: [1] }
    : { mime: 'image/jpeg', qualities: JPEG_QUALITIES }

export type EncodeDecision =
  | Readonly<{ kind: 'accept' }>
  | Readonly<{ kind: 'retry'; quality: number }>
  | Readonly<{ kind: 'refuse' }>

// NOTE: After the image was encoded with `qualities[attempt]` and came to
// `bytes` bytes: accept it, try the next lower quality (a JPEG gets one more
// try), or refuse it.
export const decideAfterEncoding = (
  format: OutputFormat,
  attempt: number,
  bytes: number,
): EncodeDecision => {
  if (bytes <= IMAGE_MAX_BYTES) {
    return { kind: 'accept' }
  }
  const next = format.qualities[attempt + 1]
  return next === undefined
    ? { kind: 'refuse' }
    : { kind: 'retry', quality: next }
}

export type ChunkRange = Readonly<{ index: number; start: number; end: number }>

// NOTE: The byte ranges of the chunks of an image of `size` bytes, in order,
// each at most `IMAGE_CHUNK_BYTES`.
export const planChunks = (
  size: number,
  chunkBytes: number = IMAGE_CHUNK_BYTES,
): ReadonlyArray<ChunkRange> =>
  size <= 0
    ? []
    : Array.makeBy(Math.ceil(size / chunkBytes), index => ({
        index,
        start: index * chunkBytes,
        end: Math.min(size, (index + 1) * chunkBytes),
      }))

// NOTE: Whole-image progress, 0 to 100, after `done` of `total` bytes.
export const percentDone = (done: number, total: number): number =>
  total <= 0 ? 0 : Math.min(100, Math.floor((done * 100) / total))

// ---- Words for people ---------------------------------------------------------------------------

const MEGABYTE = 1_000_000

export const formatBytes = (bytes: number): string =>
  bytes < MEGABYTE
    ? `${Math.max(0, Math.ceil(bytes / 1000))} KB`
    : `${(Math.round(bytes / 100_000) / 10).toFixed(1)} MB`

export const IMAGE_LIMITS_TEXT = `Each image: at most ${formatBytes(IMAGE_MAX_BYTES)}, shrunk to ${IMAGE_MAX_SIDE} pixels on its longest side. At most ${formatBytes(IMAGE_REPORT_LIMIT_BYTES)} of images per report.`

export type ImageUsage = Readonly<{ usedBytes: number; limitBytes: number }>

export const remainingBytes = (usage: ImageUsage): number =>
  Math.max(0, usage.limitBytes - usage.usedBytes)

export const usageText = (usage: ImageUsage): string =>
  `Images in this report: ${formatBytes(usage.usedBytes)} of ${formatBytes(usage.limitBytes)} used, ${formatBytes(remainingBytes(usage))} left. ${IMAGE_LIMITS_TEXT}`

export type Refusal =
  | Readonly<{ kind: 'not_an_image' }>
  | Readonly<{ kind: 'unreadable' }>
  | Readonly<{ kind: 'too_large_after_encoding'; bytes: number }>
  | Readonly<{ kind: 'report_full'; remaining: number; bytes: number }>

export const refusalText = (refusal: Refusal): string => {
  switch (refusal.kind) {
    case 'not_an_image':
      return 'That file is not a picture. Choose a JPEG, PNG, WebP or GIF image.'
    case 'unreadable':
      return 'That picture could not be read. Try another file.'
    case 'too_large_after_encoding':
      return `This picture is still ${formatBytes(refusal.bytes)} after it was made smaller, and the limit is ${formatBytes(IMAGE_MAX_BYTES)} for one image. Crop it or choose a simpler picture.`
    case 'report_full':
      return `This picture is ${formatBytes(refusal.bytes)} and this report has ${formatBytes(refusal.remaining)} of image space left (the limit is ${formatBytes(IMAGE_REPORT_LIMIT_BYTES)} per report).`
  }
}

// NOTE: Whether the encoded image fits what is left of the report's space.
// `remaining` is unknown (None) until the server has told us; the server
// decides anyway.
export const fitsReport = (
  bytes: number,
  remaining: Option.Option<number>,
): boolean =>
  Option.match(remaining, {
    onNone: () => true,
    onSome: left => bytes <= left,
  })

// NOTE: What the image route answers when it refuses (`IMAGE_ERROR_CODES`),
// in words for the author. A message from the server is never shown, only
// the code.
export const routeErrorText = (code: string, status: number): string => {
  switch (code) {
    case 'database_full':
      return 'The storage of this environment is full, so no more images can be added. Tell an administrator.'
    case 'report_limit':
      return `This report already holds the most image space it may (${formatBytes(IMAGE_REPORT_LIMIT_BYTES)}).`
    case 'too_large':
      return `The picture is over the limit of ${formatBytes(IMAGE_MAX_BYTES)}.`
    case 'bad_signature':
      return 'The server did not accept the picture as a JPEG or PNG image.'
    case 'read_only':
      return 'This report is archived and cannot be changed.'
    case 'not_found':
      return 'The picture could not be added. You may no longer have access to this report.'
    default:
      return status >= 500
        ? 'The server could not store the picture just now. Try again.'
        : 'The server did not accept the picture.'
  }
}

// NOTE: Only a failure of the network or of the server is worth sending again;
// an answer that says the request itself is wrong would only be refused again.
// A full database (507) stays full, so it is not retried either. Status 0 is
// a request that never got an answer.
export const isRetryable = (status: number): boolean =>
  status !== 507 &&
  (status === 0 || status === 408 || status === 429 || status >= 500)

export const MAX_ATTEMPTS = 3
