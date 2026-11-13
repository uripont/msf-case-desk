import { Option } from 'effect'

import {
  type Refusal,
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

const decode = (file: Blob): Promise<Option.Option<ImageBitmap>> =>
  createImageBitmap(file, { imageOrientation: 'from-image' }).then(
    Option.some,
    () => Option.none(),
  )

export const looksLikeImage = (file: Blob): boolean =>
  file.type.startsWith('image/')

export const prepareImage = async (file: Blob): Promise<Prepared> => {
  if (!looksLikeImage(file)) {
    return { ok: false, refusal: { kind: 'not_an_image' } }
  }
  const decoded = await decode(file)
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
  bitmap.close()
  const format = formatFor(
    hasTransparency(drawing.getImageData(0, 0, size.width, size.height).data),
  )
  // NOTE: tries each quality in turn (a JPEG gets one lower try), sequentially
  // because the next depends on the size of the last.
  const attempt = async (index: number): Promise<Prepared> => {
    const quality = format.qualities[index] ?? 1
    const blob = await toBlob(surface, format.mime, quality)
    if (blob === null || blob.type !== format.mime) {
      return { ok: false, refusal: { kind: 'unreadable' } }
    }
    const decision = decideAfterEncoding(format, index, blob.size)
    if (decision.kind === 'accept') {
      return {
        ok: true,
        image: {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mime: format.mime,
          width: size.width,
          height: size.height,
        },
      }
    }
    return decision.kind === 'retry'
      ? attempt(index + 1)
      : {
          ok: false,
          refusal: { kind: 'too_large_after_encoding', bytes: blob.size },
        }
  }
  return attempt(0)
}
