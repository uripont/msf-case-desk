import { Schema } from 'effect'
import { CustomElement } from 'foldkit'

// NOTE: The binding of the editor element, with no Tiptap in it, so the main
// chunk can render the tag. The element class lives in `element.ts`, which is
// loaded lazily (`LoadEditor` in `report.ts`).
export const EDITOR_TAG = 'quoroom-editor'

export const editorElement = CustomElement.define({
  tag: EDITOR_TAG,
  properties: {
    content: Schema.String,
    version: Schema.Number,
    disabled: Schema.Boolean,
    label: Schema.String,
    report: Schema.String,
    remaining: Schema.Number,
  },
  events: {
    change: Schema.Struct({ content: Schema.String, version: Schema.Number }),
    selection: Schema.Struct({
      from: Schema.Number,
      to: Schema.Number,
      text: Schema.String,
    }),
    image: Schema.Struct({ imageId: Schema.String, size: Schema.Number }),
  },
})
