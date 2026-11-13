import { Match, Schema } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineTaggedUnion } from 'foldkit/schema'

import { Failure } from './failure'
import { alertText, failureAlert, statusText } from './ui'

// NOTE: Where a form is: being edited, being sent, refused here before it was
// sent (`Invalid`), or refused by the server (`Failed`).
export const FormState = defineTaggedUnion({
  Editing: {},
  Submitting: {},
  Invalid: { message: Schema.String },
  Failed: { failure: Failure },
})
export type FormState = typeof FormState.Type

export const isSubmitting = (state: FormState): boolean =>
  FormState.guards.Submitting(state)

export const formStatus = <M>(
  h: HtmlBuilder<M>,
  state: FormState,
  busyText: string,
): Html =>
  Match.value(state).pipe(
    Match.tagsExhaustive({
      Editing: () => h.empty,
      Submitting: () => statusText(h, busyText),
      Invalid: ({ message }) => alertText(h, message),
      Failed: ({ failure }) => failureAlert(h, failure),
    }),
  )
