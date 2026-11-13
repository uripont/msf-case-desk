import { Option } from 'effect'

import {
  HEADER_BYTES,
  checkInput,
  decodeSize,
  readHeader,
  uprightSize,
} from './header'
import {
  MAX_INPUT_BYTES,
  type Refusal,
  type Size,
  decideAfterEncoding,
  fitWithin,
  formatFor,
  hasTransparency,
} from './plan'

// NOTE: Preparing a picture in the browser (stage 4d, D3): decode it, shrink it
// to at most 1600 pixels on the longest side, and save it again as JPEG (a
// photo) or PNG (when it has transparency). Drawing the picture on a canvas and
// saving that is what removes its metadata (EXIF, GPS, camera and time); the
// canvas keeps only the pixels. The picture is turned upright first
// (`imageOrientation: 'from-image'`) so dropping the orientation tag changes
// nothing the author sees. Only browser APIs are used.
//
// Before anything is decoded the header is read (`header.ts`) and a file over
// the byte cap or the pixel cap is refused, so a huge file cannot use up the
// memory of the tab. A picture larger than the target is decoded directly at
// the target size (`resizeWidth`/`resizeHeight`), never at full size. A
// transparent picture still over 1 MB as PNG is drawn again at 1200 and then
// 900 pixels before it is refused.

export type PreparedImage = Readonly<{
  bytes: Uint8Array
  mime: 'image/jpeg' | 'image/png'
  width: number
  height: number
}>

export type Prepared =
  | Readonly<{ ok: true; image: PreparedImage }>
  | Readonly<{ ok: false; refusal: Refusal }>

type Surface = OffscreenCanvas | HTMLCanvasElement

const makeSurface = (width: number, height: number): Surface => {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height)
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

const contextOf = (surface: Surface) => {
  const context = surface.getContext('2d', { willReadFrequently: true })
  return context === null ? Option.none() : Option.some(context)
}

const toBlob = (
  surface: Surface,
  mime: string,
  quality: number,
): Promise<Blob | null> =>
  surface instanceof HTMLCanvasElement
    ? new Promise(resolve => surface.toBlob(resolve, mime, quality))
    : surface.convertToBlob({ type: mime, quality })

const decode = (
  file: Blob,
  target: Option.Option<{ width: number; height: number }>,
): Promise<Option.Option<ImageBitmap>> =>
  createImageBitmap(file, {
    imageOrientation: 'from-image',
    ...Option.match(target, {
      onNone: () => ({}),
      onSome: size => ({
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'high' as const,
      }),
    }),
  }).then(Option.some, () => Option.none())

export const looksLikeImage = (file: Blob): boolean =>
  file.type.startsWith('image/')

export const prepareImage = async (file: Blob): Promise<Prepared> => {
  if (!looksLikeImage(file)) {
    return { ok: false, refusal: { kind: 'not_an_image' } }
  }
  if (file.size > MAX_INPUT_BYTES) {
    return { ok: false, refusal: { kind: 'file_too_large', bytes: file.size } }
  }
  const header = readHeader(
    new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer()),
  )
  if (Option.isNone(header)) {
    return { ok: false, refusal: { kind: 'unreadable' } }
  }
  const upright = uprightSize(header.value)
  const check = checkInput(file.size, upright)
  if (check.kind !== 'ok') {
    return { ok: false, refusal: check }
  }
  const decoded = await decode(file, decodeSize(upright))
  if (Option.isNone(decoded)) {
    return { ok: false, refusal: { kind: 'unreadable' } }
  }
  const bitmap = decoded.value
  const size = fitWithin({ width: bitmap.width, height: bitmap.height })
  const surface = makeSurface(size.width, size.height)
  const context = contextOf(surface)
  if (Option.isNone(context)) {
    bitmap.close()
    return { ok: false, refusal: { kind: 'unreadable' } }
  }
  const drawing = context.value
  drawing.imageSmoothingEnabled = true
  drawing.imageSmoothingQuality = 'high'
  drawing.drawImage(bitmap, 0, 0, size.width, size.height)
  const format = formatFor(
    hasTransparency(drawing.getImageData(0, 0, size.width, size.height).data),
  )
  // NOTE: tries each quality in turn (a JPEG gets one lower try), sequentially
  // because the next depends on the size of the last. A PNG over the limit is
  // drawn again on a smaller surface (`step` into `format.sides`), from the
  // bitmap kept until the end.
  const attempt = async (
    index: number,
    step: number,
    current: Surface,
    at: Size,
  ): Promise<Prepared> => {
    const quality = format.qualities[index] ?? 1
    const blob = await toBlob(current, format.mime, quality)
    if (blob === null || blob.type !== format.mime) {
      return { ok: false, refusal: { kind: 'unreadable' } }
    }
    const decision = decideAfterEncoding(format, index, blob.size, step)
    if (decision.kind === 'accept') {
      return {
        ok: true,
        image: {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mime: format.mime,
          width: at.width,
          height: at.height,
        },
      }
    }
    if (decision.kind === 'retry') {
      return attempt(index + 1, step, current, at)
    }
    if (decision.kind === 'shrink') {
      const smaller = fitWithin(size, decision.side)
      const next = makeSurface(smaller.width, smaller.height)
      const nextContext = contextOf(next)
      if (Option.isNone(nextContext)) {
        return { ok: false, refusal: { kind: 'unreadable' } }
      }
      nextContext.value.imageSmoothingEnabled = true
      nextContext.value.imageSmoothingQuality = 'high'
      nextContext.value.drawImage(bitmap, 0, 0, smaller.width, smaller.height)
      return attempt(0, step + 1, next, smaller)
    }
    return {
      ok: false,
      refusal: { kind: 'too_large_after_encoding', bytes: blob.size },
    }
  }
  try {
    return await attempt(0, 0, surface, size)
  } finally {
    bitmap.close()
  }
}
