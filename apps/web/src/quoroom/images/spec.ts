import { Schema } from 'effect'
import { CustomElement } from 'foldkit'

// NOTE: The binding of the image element, with no logic in it, so a Foldkit
// view can render the tag. The element class is in `figureImage.ts`, which
// registers it when imported.
export const IMAGE_TAG = 'quoroom-image'

export const imageElement = CustomElement.define({
  tag: IMAGE_TAG,
  properties: {
    imageId: Schema.String,
    report: Schema.String,
    alt: Schema.String,
  },
  events: {},
})
