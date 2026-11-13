import { Effect, Layer, Option, Result, Schema } from 'effect'

import {
  type Action,
  type ImageRecord,
  IMAGE_CHUNK_BYTES,
  IMAGE_ERROR_STATUS,
  IMAGE_ROUTE,
  ImageChunkQueryFromStrings,
  ImageReadQuery,
  Repository,
  ReportRepository,
  authorize,
} from '@case-desk/domain'

import { bytesToBase64 } from './content'
import {
  type Deps,
  QuoroomClock,
  QuoroomConfig,
  QuoroomIds,
  loadReport,
  store,
} from './core'
import { sessionUser, tokenFromCookies } from '../session'

// NOTE: The `/api/images` route (D5). Bytes never go through the RPC. The
// session cookie authenticates and `authorize` decides, as in the RPC: the
// answer for a report the caller may not read, an image it may not see and a
// report or image that does not exist is the same `not_found`. Images that
// are not marked safe are never served to a redacted role: the repository
// reads them through the revision or draft that references them, with
// `safeOnly` set from the role's view, which is the server's choice.

type ErrorCode = keyof typeof IMAGE_ERROR_STATUS

const fail = (code: ErrorCode, message = code.replaceAll('_', ' ')): Response =>
  Response.json(
    { code, message },
    { status: IMAGE_ERROR_STATUS[code], headers: { 'cache-control': 'no-store' } },
  )

const ok = (body: unknown): Response =>
  Response.json(body, { headers: { 'cache-control': 'no-store' } })

const decodeUpload = Schema.decodeUnknownResult(ImageChunkQueryFromStrings)
const decodeRead = Schema.decodeUnknownResult(ImageReadQuery)

// NOTE: JPEG (FF D8 FF) or PNG (89 'PNG' CR LF 1A LF), by signature.
const signatureOk = (mime: 'image/jpeg' | 'image/png', bytes: Uint8Array) =>
  mime === 'image/jpeg'
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, at) => bytes[at] === byte,
      )

const meta = (image: ImageRecord) => ({
  id: image.id,
  owner: image.owner,
  mime: image.mime,
  width: image.width,
  height: image.height,
  size: image.size,
  hash: image.hash,
  uploadedBy: image.uploadedBy,
  uploadedAt: image.createdAt,
  referenced: image.referenced,
  safeToShare: false,
})

const queryOf = (url: URL): Record<string, string> =>
  Object.fromEntries(url.searchParams.entries())

// NOTE: what the caller may do on a report, or the refusal as a code.
const authorizeReport = (
  userId: string,
  reportId: string,
  action: Action,
): Effect.Effect<
  Readonly<{ view?: 'original' | 'redacted' }>,
  ErrorCode,
  Deps
> =>
  Effect.gen(function* () {
    const loaded = yield* loadReport(reportId).pipe(
      Effect.mapError((): ErrorCode => 'not_found'),
    )
    const result = authorize({ id: userId, grants: [] }, loaded?.access, action)
    if (result.allowed) return result
    return yield* Effect.fail<ErrorCode>(
      result.reason === 'read_only' ? 'read_only' : 'not_found',
    )
  })

const upload = (request: Request, userId: string, url: URL) =>
  Effect.gen(function* () {
    const decoded = decodeUpload(queryOf(url))
    if (Result.isFailure(decoded)) return fail('bad_request')
    const query = decoded.success
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > IMAGE_CHUNK_BYTES) return fail('too_large')
    const bytes = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()))
    if (bytes.length > IMAGE_CHUNK_BYTES) return fail('too_large')
    if (bytes.length === 0) return fail('bad_request')
    if (query.index === 0 && !signatureOk(query.mime, bytes)) {
      return fail('bad_signature')
    }
    if (query.owner === 'theme') {
      // NOTE: the logo belongs to the administrator.
      const db = yield* store
      const grants = yield* db.listGrants(userId)
      const result = authorize(
        {
          id: userId,
          grants: grants.map(grant => ({
            capability: grant.capability,
            ...(grant.unitId === null ? {} : { unit: grant.unitId }),
          })),
        },
        undefined,
        { type: 'set_theme' },
      )
      if (!result.allowed) return fail('not_found')
    } else {
      yield* authorizeReport(userId, query.owner, {
        type: 'save_section',
        sectionId: '',
      })
    }
    const db = yield* store
    const clock = yield* QuoroomClock
    const outcome = yield* db.putImageChunk({
      imageId: query.uploadId,
      owner:
        query.owner === 'theme'
          ? { kind: 'theme' }
          : { kind: 'report', reportId: query.owner },
      uploadedBy: userId,
      mime: query.mime,
      width: query.width,
      height: query.height,
      size: query.size,
      hash: query.uploadId,
      chunkCount: query.chunks,
      index: query.index,
      data: bytesToBase64(bytes),
      now: yield* clock.now,
    })
    if (outcome._tag === 'Refused') {
      switch (outcome.reason) {
        case 'report_limit':
          return fail('report_limit')
        case 'database_full':
          return fail('database_full')
        default:
          return fail('bad_request')
      }
    }
    return ok({
      uploadId: query.uploadId,
      received: outcome.received,
      complete: outcome.complete,
      ...(outcome.image === null ? {} : { image: meta(outcome.image) }),
    })
  })

const read = (userId: string, id: string, index: number, url: URL) =>
  Effect.gen(function* () {
    const decoded = decodeRead(queryOf(url))
    if (Result.isFailure(decoded)) return fail('bad_request')
    const query = decoded.success
    const db = yield* store
    const image = yield* db.getImage(id)
    if (image === null || !image.complete) return fail('not_found')
    if (index < 0 || index >= image.chunkCount) return fail('not_found')
    let chunk: string | null = null
    if (query.context === 'theme') {
      if (image.owner.kind !== 'theme') return fail('not_found')
      chunk = yield* db.readImageChunk(id, index)
    } else {
      if (query.report === undefined) return fail('bad_request')
      const reportId = query.report
      if (image.owner.kind !== 'report' || image.owner.reportId !== reportId) {
        return fail('not_found')
      }
      if (query.context === 'working_copy') {
        yield* authorizeReport(userId, reportId, {
          type: 'read_working_copy',
          ownerId: userId,
        })
        chunk = yield* db.readImageChunk(id, index)
      } else if (query.context === 'draft') {
        if (query.draft === undefined) return fail('bad_request')
        yield* authorizeReport(userId, reportId, {
          type: 'read_draft',
          number: query.draft,
        })
        chunk = yield* db.readDraftImageChunk({
          reportId,
          draftNumber: query.draft,
          imageId: id,
          index,
          safeOnly: false,
        })
      } else {
        if (query.revision === undefined) return fail('bad_request')
        const allowed = yield* authorizeReport(userId, reportId, {
          type: 'read_revision',
          revision: query.revision,
        })
        chunk = yield* db.readRevisionImageChunk({
          reportId,
          revision: query.revision,
          imageId: id,
          index,
          // NOTE: the server's choice: a redacted role gets safe images only.
          safeOnly: allowed.view !== 'original',
        })
      }
    }
    if (chunk === null) return fail('not_found')
    return ok({
      id,
      index,
      chunks: image.chunkCount,
      mime: image.mime,
      width: image.width,
      height: image.height,
      base64: chunk,
    })
  })

export const makeImageHandler = (
  layer: Layer.Layer<
    Repository | ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig
  >,
) => {
  const handle = (request: Request) =>
    Effect.gen(function* () {
      const token = tokenFromCookies(request.headers.get('cookie'))
      if (Option.isNone(token)) return fail('not_found')
      const user = yield* sessionUser(token.value)
      if (Option.isNone(user)) return fail('not_found')
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === IMAGE_ROUTE) {
        return yield* upload(request, user.value.id, url)
      }
      const parts = url.pathname.slice(IMAGE_ROUTE.length).split('/').filter(Boolean)
      if (request.method === 'GET' && parts.length === 2) {
        const index = Number(parts[1])
        if (!Number.isInteger(index)) return fail('bad_request')
        return yield* read(user.value.id, decodeURIComponent(parts[0] ?? ''), index, url)
      }
      return fail('not_found')
    })
  return (request: Request): Promise<Response> =>
    Effect.runPromise(
      handle(request).pipe(
        Effect.catch(error =>
          Effect.succeed(
            typeof error === 'string' && error in IMAGE_ERROR_STATUS
              ? fail(error as ErrorCode)
              : Response.json({ error: 'StorageUnavailable' }, { status: 503 }),
          ),
        ),
        Effect.provide(layer),
      ) as Effect.Effect<Response>,
    )
}

export { QuoroomConfig }
