import { Schema } from 'effect'
import { defineTaggedUnion } from 'foldkit/schema'

// NOTE: Whether the editor chunk is loaded. `NotLoaded` until a section with a
// rich-text item an author may edit is shown; the editor element is rendered
// only in `Ready`, because an element rendered before its class is defined has
// its properties set on an object that does not yet have the setters.
export const EditorState = defineTaggedUnion({
  NotLoaded: {},
  Loading: {},
  Ready: {},
  Failed: {},
})
export type EditorState = typeof EditorState.Type

export const RichTextSelection = Schema.Struct({
  sectionKey: Schema.String,
  itemId: Schema.String,
  from: Schema.Number,
  to: Schema.Number,
  text: Schema.String,
})
export type RichTextSelection = typeof RichTextSelection.Type

export const editorKey = (sectionKey: string, itemId: string): string =>
  `${sectionKey}/${itemId}`
