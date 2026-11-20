import { clsx } from 'clsx'
import { Html, HtmlBuilder } from 'foldkit/html'

import { fieldClassName, focusRing, labelClassName } from '../style'

// NOTE: The small pieces the drafting screen uses for entries and for *not
// applicable*: the same for a repeatable subsection and for a repeated item.
// Each takes the builder of the screen, so its handlers send that screen's
// Messages. Every control is at least 44 px high, for a phone.

const buttonClassName = clsx(
  'inline-flex min-h-11 cursor-pointer items-center justify-center border border-brand-line px-3 text-base text-brand-ink transition-colors hover:border-brand-primary hover:text-brand-primary disabled:cursor-not-allowed disabled:text-brand-grey disabled:hover:border-brand-line disabled:hover:text-brand-grey',
  focusRing,
)

export const actionButton = <M>(
  h: HtmlBuilder<M>,
  label: string,
  ariaLabel: string,
  onClick: M,
  isDisabled = false,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(buttonClassName),
      h.AriaLabel(ariaLabel),
      h.Disabled(isDisabled),
      h.OnClick(onClick),
    ],
    [label],
  )

export type EntryControls<M> = Readonly<{
  label: string
  canMoveUp: boolean
  canMoveDown: boolean
  onMoveUp: M
  onMoveDown: M
  onRemove: M
}>

export const entryControls = <M>(
  h: HtmlBuilder<M>,
  controls: EntryControls<M>,
): Html =>
  h.div(
    [
      h.Class('flex flex-wrap gap-2'),
      h.Role('group'),
      h.AriaLabel(controls.label),
    ],
    [
      actionButton(
        h,
        'Move up',
        `Move ${controls.label} up`,
        controls.onMoveUp,
        !controls.canMoveUp,
      ),
      actionButton(
        h,
        'Move down',
        `Move ${controls.label} down`,
        controls.onMoveDown,
        !controls.canMoveDown,
      ),
      actionButton(h, 'Remove', `Remove ${controls.label}`, controls.onRemove),
    ],
  )

export const addButton = <M>(
  h: HtmlBuilder<M>,
  label: string,
  onClick: M,
  isDisabled: boolean,
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(
        clsx(
          'inline-flex min-h-11 cursor-pointer items-center self-start border border-brand-ink px-4 text-base font-medium text-brand-ink transition-colors hover:bg-brand-mist disabled:cursor-not-allowed disabled:border-brand-line disabled:text-brand-grey disabled:hover:bg-transparent',
          focusRing,
        ),
      ),
      h.Disabled(isDisabled),
      h.OnClick(onClick),
    ],
    [label],
  )

export const countLine = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.p([h.Role('status'), h.Class('text-sm text-brand-grey')], [text])

// ---- Not applicable ------------------------------------------------------------------

export type NotApplicableForm<M> = Readonly<{
  id: string
  label: string
  reason: string
  isMissing: boolean
  onType: (text: string) => M
  onSubmit: M
  onCancel: M
}>

export const notApplicableForm = <M>(
  h: HtmlBuilder<M>,
  form: NotApplicableForm<M>,
): Html =>
  h.form(
    [
      h.AriaLabel(`Not applicable: ${form.label}`),
      h.Class(
        'flex flex-col gap-3 border-l-2 border-brand-ink bg-brand-mist px-4 py-3',
      ),
      h.OnSubmit(form.onSubmit),
    ],
    [
      h.label(
        [h.Class(labelClassName), h.For(`na-${form.id}`)],
        ['Why is this not applicable?'],
      ),
      h.p(
        [h.Class('-mt-1 text-sm text-brand-grey')],
        ['A reason is required. What is already written here is kept.'],
      ),
      h.textarea([
        h.Id(`na-${form.id}`),
        h.Value(form.reason),
        h.Class(clsx(fieldClassName, 'min-h-24')),
        h.AriaInvalid(form.isMissing),
        h.OnInput(form.onType),
      ]),
      form.isMissing
        ? h.p(
            [h.Role('alert'), h.Class('text-base font-medium text-brand-alert')],
            ['Write a reason before marking this as not applicable.'],
          )
        : h.empty,
      h.div(
        [h.Class('flex flex-wrap gap-2')],
        [
          h.button(
            [
              h.Type('submit'),
              h.Class(
                clsx(
                  'inline-flex min-h-11 cursor-pointer items-center border border-brand-ink bg-brand-ink px-4 text-base font-medium text-white',
                  focusRing,
                ),
              ),
            ],
            ['Mark as not applicable'],
          ),
          actionButton(
            h,
            'Cancel',
            `Cancel not applicable: ${form.label}`,
            form.onCancel,
          ),
        ],
      ),
    ],
  )

export const notApplicableNotice = <M>(
  h: HtmlBuilder<M>,
  config: Readonly<{
    label: string
    reason: string
    isDisabled: boolean
    onEdit: M
    onRestore: M
    keeps: string
  }>,
): Html =>
  h.div(
    [
      h.Role('group'),
      h.AriaLabel(`Not applicable: ${config.label}`),
      h.Class(
        'flex flex-col gap-3 border-l-2 border-brand-ink bg-brand-mist px-4 py-3',
      ),
    ],
    [
      h.p(
        [h.Class('text-base font-medium text-brand-ink')],
        ['Not applicable'],
      ),
      h.p([h.Class('text-pretty text-lg text-brand-ink')], [config.reason]),
      h.p([h.Class('text-sm text-brand-grey')], [config.keeps]),
      config.isDisabled
        ? h.empty
        : h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              actionButton(
                h,
                'Edit the reason',
                `Edit the reason for ${config.label}`,
                config.onEdit,
              ),
              actionButton(
                h,
                'Mark as applicable again',
                `Mark ${config.label} as applicable again`,
                config.onRestore,
              ),
            ],
          ),
    ],
  )

export const notApplicableButton = <M>(
  h: HtmlBuilder<M>,
  label: string,
  onClick: M,
): Html =>
  actionButton(h, 'Not applicable', `Mark ${label} as not applicable`, onClick)
