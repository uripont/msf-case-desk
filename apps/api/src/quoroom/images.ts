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
import { checkImageBytes } from './imageCheck'
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
      // NOTE: the logo belongs to whoever holds Theme.
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
    if (outcome.complete && outcome.image !== null) {
      // NOTE: the whole image is checked once it is complete (`imageCheck.ts`),
      // across its chunks; one that carries metadata is deleted again.
      const stored: Array<Uint8Array> = []
      for (let at = 0; at < outcome.image.chunkCount; at += 1) {
        const text = yield* db.readImageChunk(query.uploadId, at)
        if (text === null) return fail('bad_request')
        stored.push(Uint8Array.from(atob(text), c => c.charCodeAt(0)))
      }
      const joined = new Uint8Array(stored.reduce((n, part) => n + part.length, 0))
      stored.reduce((offset, part) => (joined.set(part, offset), offset + part.length), 0)
      const verdict = checkImageBytes(query.mime, joined)
      if (verdict !== 'clean') {
        yield* db.deleteUnreferencedImage(query.uploadId)
        return verdict === 'has_metadata'
          ? fail('has_metadata', 'the picture carries metadata')
          : fail('bad_signature')
      }
    }
    return ok({
      uploadId: query.uploadId,
      received: outcome.received,
      complete: outcome.complete,
      ...(outcome.image === null ? {} : { image: meta(outcome.image) }),
    })
  })

const served = (image: ImageRecord, id: string, index: number, chunk: string) =>
  ok({
    id,
    index,
    chunks: image.chunkCount,
    mime: image.mime,
    width: image.width,
    height: image.height,
    base64: chunk,
  })

const read = (userId: string, id: string, index: number, url: URL) =>
  Effect.gen(function* () {
    const decoded = decodeRead(queryOf(url))
    if (Result.isFailure(decoded)) return fail('bad_request')
    const query = decoded.success
    const db = yield* store
    // NOTE: the parameters are validated and the caller authorized BEFORE the
    // image is looked up, so a missing parameter, an image that is not
    // referenced by the version asked for and one that does not exist all
    // answer the same `not_found`: the route is no oracle for image IDs.
    if (query.context === 'theme') {
      const image = yield* db.getImage(id)
      if (
        image === null ||
        !image.complete ||
        index < 0 ||
        index >= image.chunkCount ||
        image.owner.kind !== 'theme'
      ) {
        return fail('not_found')
      }
      const chunk = yield* db.readImageChunk(id, index)
      if (chunk === null) return fail('not_found')
      return served(image, id, index, chunk)
    }
    const reportId = query.report
    if (reportId === undefined) return fail('not_found')
    let version:
      | Readonly<{ kind: 'working_copy' }>
      | Readonly<{ kind: 'draft'; number: number }>
      | Readonly<{ kind: 'revision'; number: number; safeOnly: boolean }>
    if (query.context === 'working_copy') {
      yield* authorizeReport(userId, reportId, {
        type: 'read_working_copy',
        ownerId: userId,
      })
      version = { kind: 'working_copy' }
    } else if (query.context === 'draft') {
      if (query.draft === undefined) return fail('not_found')
      yield* authorizeReport(userId, reportId, {
        type: 'read_draft',
        number: query.draft,
      })
      version = { kind: 'draft', number: query.draft }
    } else {
      if (query.revision === undefined) return fail('not_found')
      const allowed = yield* authorizeReport(userId, reportId, {
        type: 'read_revision',
        revision: query.revision,
      })
      // NOTE: the server's choice: a redacted role gets safe images only.
      version = {
        kind: 'revision',
        number: query.revision,
        safeOnly: allowed.view !== 'original',
      }
    }
    const image = yield* db.getImage(id)
    if (image === null || !image.complete) return fail('not_found')
    if (index < 0 || index >= image.chunkCount) return fail('not_found')
    if (image.owner.kind !== 'report' || image.owner.reportId !== reportId) {
      return fail('not_found')
    }
    let chunk: string | null
    if (version.kind === 'working_copy') {
      chunk = yield* db.readImageChunk(id, index)
    } else if (version.kind === 'draft') {
      chunk = yield* db.readDraftImageChunk({
        reportId,
        draftNumber: version.number,
        imageId: id,
        index,
        safeOnly: false,
      })
    } else {
      chunk = yield* db.readRevisionImageChunk({
        reportId,
        revision: version.number,
        imageId: id,
        index,
        safeOnly: version.safeOnly,
      })
    }
    if (chunk === null) return fail('not_found')
    return served(image, id, index, chunk)
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
        // NOTE: a malformed percent-encoding is a bad request, not a defect.
        const id = (() => {
          try {
            return decodeURIComponent(parts[0] ?? '')
          } catch {
            return undefined
          }
        })()
        if (id === undefined) return fail('bad_request')
        return yield* read(user.value.id, id, index, url)
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
