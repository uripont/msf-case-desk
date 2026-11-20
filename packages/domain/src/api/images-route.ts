import { Schema } from 'effect'

import { ApiId, Count } from './common'
import { ImageMeta, ImageMime } from './reports'

// NOTE: The `/api/images` route (D5). Image bytes never go through
// the RPC: they would be decoded and re-encoded by its Schemas. The route is
// authenticated by the same session cookie and authorizes like the RPC does.
// This file only describes its requests and responses.
//
// Upload: `POST /api/images?...` with the raw bytes of one chunk as the
// body (`content-type: application/octet-stream`), the fields of
// `ImageChunkQueryFromStrings` in the query string. A chunk is at most
// `IMAGE_CHUNK_BYTES`; the browser has already resized the image to at most
// `IMAGE_MAX_SIDE` pixels and re-encoded it, which drops its metadata.
//
// Read: `GET /api/images/<id>/<index>?...` with the fields of
// `ImageReadQuery`. The answer is the stored base64 text of one chunk, so the
// Worker never decodes it.

export const IMAGE_ROUTE = '/api/images'
export const IMAGE_CHUNK_BYTES = 700_000
export const IMAGE_MAX_BYTES = 1_000_000
export const IMAGE_MAX_SIDE = 1600
export const IMAGE_REPORT_LIMIT_BYTES = 20_000_000
export const DATABASE_LIMIT_BYTES = 400_000_000
export const IMAGE_MAX_CHUNKS = Math.ceil(IMAGE_MAX_BYTES / IMAGE_CHUNK_BYTES)

const ChunkIndex = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: IMAGE_MAX_CHUNKS - 1 }),
)

// ---- Upload ------------------------------------------------------------------------------------

const intFromString = (minimum: number, maximum: number) =>
  Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ minimum, maximum }))

// NOTE: The query string of an upload request. Numbers arrive as text in a
// query; the route decodes them with `ImageChunkQueryFromStrings`.
export const ImageChunkQueryFromStrings = Schema.Struct({
  uploadId: ApiId,
  owner: Schema.Union([ApiId, Schema.Literal('theme')]),
  index: intFromString(0, IMAGE_MAX_CHUNKS - 1),
  chunks: intFromString(1, IMAGE_MAX_CHUNKS),
  mime: ImageMime,
  width: intFromString(1, IMAGE_MAX_SIDE),
  height: intFromString(1, IMAGE_MAX_SIDE),
  size: intFromString(1, IMAGE_MAX_BYTES),
})

// NOTE: 200 with this body. `image` is present once the last chunk has
// arrived and the whole image was checked (size, signature, limits).
export const ImageChunkResult = Schema.Struct({
  uploadId: ApiId,
  received: Count,
  complete: Schema.Boolean,
  image: Schema.optionalKey(ImageMeta),
})
export type ImageChunkResult = typeof ImageChunkResult.Type

// ---- Read ------------------------------------------------------------------------------------------

export const ImageReadQuery = Schema.Struct({
  context: Schema.Literals(['working_copy', 'draft', 'revision', 'theme']),
  report: Schema.optionalKey(ApiId),
  draft: Schema.optionalKey(intFromString(0, 100_000)),
  revision: Schema.optionalKey(intFromString(1, 100_000)),
})

export const ImageChunkRead = Schema.Struct({
  id: ApiId,
  index: ChunkIndex,
  chunks: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: IMAGE_MAX_CHUNKS }),
  ),
  mime: ImageMime,
  width: Schema.Int,
  height: Schema.Int,
  // NOTE: Standard base64 text of this chunk's bytes.
  base64: Schema.String,
})
export type ImageChunkRead = typeof ImageChunkRead.Type

// ---- Errors ------------------------------------------------------------------------------------------

export const IMAGE_ERROR_CODES = [
  // 404: forbidden and missing look the same.
  'not_found',
  // 400: bad query, an out-of-order chunk or a size mismatch.
  'bad_request',
  // 413: the chunk is over `IMAGE_CHUNK_BYTES` or the image over 1 MB.
  'too_large',
  // 415: the bytes are not a JPEG or a PNG (checked by their signature).
  'bad_signature',
  // 415: the picture carries metadata (EXIF, XMP, PNG text chunks); the
  // browser re-encodes pictures, so a file that has some was not prepared by it.
  'has_metadata',
  // 409: the report holds `IMAGE_REPORT_LIMIT_BYTES` of referenced images.
  'report_limit',
  // 507: the database passed `DATABASE_LIMIT_BYTES`; uploads stop.
  'database_full',
  // 409: the report is archived.
  'read_only',
] as const

export const IMAGE_ERROR_STATUS: Readonly<
  Record<(typeof IMAGE_ERROR_CODES)[number], number>
> = {
  not_found: 404,
  bad_request: 400,
  too_large: 413,
  bad_signature: 415,
  has_metadata: 415,
  report_limit: 409,
  database_full: 507,
  read_only: 409,
}

export const ImageRouteError = Schema.Struct({
  code: Schema.Literals(IMAGE_ERROR_CODES),
  message: Schema.String.check(Schema.isMaxLength(200)),
})
export type ImageRouteError = typeof ImageRouteError.Type
