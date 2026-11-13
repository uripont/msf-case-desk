import { Option, Schema } from 'effect'

import {
  IMAGE_ROUTE,
  ImageChunkResult,
  ImageRouteError,
} from '@case-desk/domain'

import type { PreparedImage } from './encode'
import {
  MAX_ATTEMPTS,
  isRetryable,
  percentDone,
  planChunks,
  routeErrorText,
} from './plan'

// NOTE: Uploading a prepared image through `/api/images` (stage 4d, D5). Bytes
// never go through the RPC. The image is cut into chunks of at most 700 KB and
// sent in order, each as the raw body of a POST with its description in the
// query string. A chunk that fails for a reason that may pass (no network, a
// server error) is sent again up to three times; the server accepts an
// identical chunk twice, so a retry can never make a copy. If the three tries
// fail, the result says which chunk to resume from, and the author can retry
// from there.

export type UploadProgress = Readonly<{
  percent: number
  chunk: number
  chunks: number
}>

export type UploadResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      message: string
      // NOTE: The chunk to resume from, when trying again may help.
      resumeAt: Option.Option<number>
    }>

export type UploadRequest = Readonly<{
  reportId: string
  uploadId: string
  image: PreparedImage
  startAt: number
  signal?: AbortSignal
  onProgress: (progress: UploadProgress) => void
}>

const decodeResult = Schema.decodeUnknownOption(ImageChunkResult)
const decodeError = Schema.decodeUnknownOption(ImageRouteError)

const pause = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

type ChunkOutcome =
  | Readonly<{ kind: 'sent' }>
  | Readonly<{ kind: 'failed'; status: number; code: string }>

const sendChunk = async (
  request: UploadRequest,
  index: number,
  chunks: number,
  body: Uint8Array<ArrayBuffer>,
): Promise<ChunkOutcome> => {
  const { image, reportId, uploadId } = request
  const query = new URLSearchParams({
    uploadId,
    owner: reportId,
    index: String(index),
    chunks: String(chunks),
    mime: image.mime,
    width: String(image.width),
    height: String(image.height),
    size: String(image.bytes.length),
  })
  try {
    const response = await fetch(`${IMAGE_ROUTE}?${query.toString()}`, {
      method: 'POST',
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      headers: { 'content-type': 'application/octet-stream' },
      body,
    })
    if (response.ok) {
      const parsed: unknown = await response.json().catch(() => undefined)
      return Option.isSome(decodeResult(parsed))
        ? { kind: 'sent' }
        : { kind: 'failed', status: 502, code: 'unknown' }
    }
    const failure: unknown = await response.json().catch(() => undefined)
    const known = decodeError(failure)
    return {
      kind: 'failed',
      status: response.status,
      code: Option.isSome(known) ? known.value.code : 'unknown',
    }
  } catch (_error) {
    return { kind: 'failed', status: 0, code: 'network' }
  }
}

const sendWithRetries = async (
  request: UploadRequest,
  index: number,
  chunks: number,
  body: Uint8Array<ArrayBuffer>,
  attempt = 1,
): Promise<ChunkOutcome> => {
  const outcome = await sendChunk(request, index, chunks, body)
  if (
    outcome.kind === 'failed' &&
    request.signal?.aborted !== true &&
    isRetryable(outcome.status) &&
    attempt < MAX_ATTEMPTS
  ) {
    await pause(400 * attempt)
    return sendWithRetries(request, index, chunks, body, attempt + 1)
  }
  return outcome
}

export const uploadImage = async (
  request: UploadRequest,
): Promise<UploadResult> => {
  const ranges = planChunks(request.image.bytes.length)
  const sendFrom = async (at: number): Promise<UploadResult> => {
    const range = ranges[at]
    if (range === undefined) {
      return { ok: true }
    }
    request.onProgress({
      percent: percentDone(range.start, request.image.bytes.length),
      chunk: at + 1,
      chunks: ranges.length,
    })
    const outcome = await sendWithRetries(
      request,
      range.index,
      ranges.length,
      request.image.bytes.slice(range.start, range.end),
    )
    if (outcome.kind === 'sent') {
      return sendFrom(at + 1)
    }
    return {
      ok: false,
      message:
        outcome.status === 0
          ? 'The connection was lost while sending the picture. Check it and try again.'
          : routeErrorText(outcome.code, outcome.status),
      resumeAt: isRetryable(outcome.status) ? Option.some(at) : Option.none(),
    }
  }
  return sendFrom(request.startAt)
}
