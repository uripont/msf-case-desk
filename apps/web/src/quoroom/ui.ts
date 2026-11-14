import { clsx } from 'clsx'
import { Array, Option, Redacted } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import {
  fieldClassName,
  focusRing,
  labelClassName,
  primaryButtonClassName,
} from '../style'
import { type Failure, failureText } from './failure'

// NOTE: Shared pieces for the screens. Each takes the builder of
// the screen that uses it, so its handlers send that screen's Messages.

export const PAGE_HEADING_ID = 'page-heading'

export const pageShell = <M>(
  h: HtmlBuilder<M>,
  label: string,
  title: string,
  lede: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel(label),
      h.Class('flex max-w-3xl flex-col gap-10 pb-14 pt-10 md:pb-20 md:pt-14'),
    ],
    [
      h.div(
        [h.Class('flex flex-col gap-3')],
        [
          h.h1(
            [
              h.Id(PAGE_HEADING_ID),
              h.Class(
                'text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
              ),
            ],
            [title],
          ),
          lede === ''
            ? h.empty
            : h.p(
                [h.Class('text-pretty text-lg font-light text-msf-ink')],
                [lede],
              ),
        ],
      ),
      ...children,
    ],
  )

export const panel = <M>(
  h: HtmlBuilder<M>,
  heading: string,
  children: ReadonlyArray<Html>,
  maybeNote: Option.Option<string> = Option.none(),
): Html =>
  h.section(
    [
      h.AriaLabel(heading),
      h.Class('flex flex-col gap-5 border-t-2 border-msf-ink pt-5'),
    ],
    [
      h.h2([h.Class('text-2xl font-black tracking-tight')], [heading]),
      Option.match(maybeNote, {
        onNone: () => h.empty,
        onSome: note =>
          h.p([h.Class('-mt-2 text-pretty text-base text-msf-grey')], [note]),
      }),
      ...children,
    ],
  )

export type TextFieldConfig<M> = Readonly<{
  id: string
  label: string
  value: string
  type?: 'text' | 'email' | 'tel'
  autocomplete?: string
  hint?: string
  onInput: (value: string) => M
}>

export const textField = <M>(
  h: HtmlBuilder<M>,
  config: TextFieldConfig<M>,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.Class(labelClassName), h.For(config.id)], [config.label]),
      config.hint === undefined
        ? h.empty
        : h.p([h.Class('-mt-1 text-sm text-msf-grey')], [config.hint]),
      h.input([
        h.Id(config.id),
        h.Type(config.type ?? 'text'),
        h.Value(config.value),
        h.Class(fieldClassName),
        ...(config.autocomplete === undefined
          ? [h.Autocomplete('off')]
          : [h.Autocomplete(config.autocomplete)]),
        h.OnInput(config.onInput),
      ]),
    ],
  )

export const passwordField = <M>(
  h: HtmlBuilder<M>,
  id: string,
  label: string,
  value: Redacted.Redacted<string>,
  onInput: (value: string) => M,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.Class(labelClassName), h.For(id)], [label]),
      h.input([
        h.Id(id),
        h.Type('password'),
        h.Name(id),
        h.Autocomplete('new-password'),
        h.Required(true),
        h.Value(Redacted.value(value)),
        h.Class(fieldClassName),
        h.OnInput(onInput),
      ]),
    ],
  )

export const checkboxField = <M>(
  h: HtmlBuilder<M>,
  id: string,
  label: string,
  isChecked: boolean,
  onClick: M,
  maybeHint: Option.Option<string> = Option.none(),
): Html =>
  h.div(
    [h.Class('flex flex-col gap-1')],
    [
      h.label(
        [h.Class('flex cursor-pointer items-start gap-3 text-lg'), h.For(id)],
        [
          h.input([
            h.Id(id),
            h.Type('checkbox'),
            h.Class('mt-1 size-5 shrink-0 accent-msf-red'),
            h.Checked(isChecked),
            h.OnClick(onClick),
          ]),
          label,
        ],
      ),
      Option.match(maybeHint, {
        onNone: () => h.empty,
        onSome: hint => h.p([h.Class('ml-8 text-sm text-msf-grey')], [hint]),
      }),
    ],
  )

export const selectField = <M>(
  h: HtmlBuilder<M>,
  id: string,
  label: string,
  selected: string,
  choices: ReadonlyArray<Readonly<{ value: string; label: string }>>,
  onChange: (value: string) => M,
): Html =>
  h.div(
    [h.Class('flex flex-col gap-2')],
    [
      h.label([h.Class(labelClassName), h.For(id)], [label]),
      h.select(
        [
          h.Id(id),
          h.Value(selected),
          h.Class(fieldClassName),
          h.OnChange(onChange),
        ],
        Array.map(choices, choice =>
          h.option(
            [h.Value(choice.value), h.Selected(choice.value === selected)],
            [choice.label],
          ),
        ),
      ),
    ],
  )

export const submitButton = <M>(
  h: HtmlBuilder<M>,
  label: string,
  isBusy: boolean,
  busyLabel: string,
): Html =>
  h.button(
    [
      h.Type('submit'),
      h.Disabled(isBusy),
      h.Class(clsx(primaryButtonClassName, 'self-start')),
    ],
    [isBusy ? busyLabel : label],
  )

export const smallButton = <M>(
  h: HtmlBuilder<M>,
  label: string,
  onClick: M,
  maybeAriaLabel: Option.Option<string> = Option.none(),
): Html =>
  h.button(
    [
      h.Type('button'),
      h.Class(
        clsx(
          'inline-flex h-10 cursor-pointer items-center justify-center border border-msf-line px-3 text-base text-msf-ink transition-colors hover:border-msf-red hover:text-msf-red',
          focusRing,
        ),
      ),
      ...Option.match(maybeAriaLabel, {
        onNone: () => [],
        onSome: name => [h.AriaLabel(name)],
      }),
      h.OnClick(onClick),
    ],
    [label],
  )

export const alertText = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.p(
    [h.Role('alert'), h.Class('text-base font-medium text-msf-alert')],
    [text],
  )

export const statusText = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.p([h.Role('status'), h.Class('text-base font-medium text-msf-ink')], [text])

export const failureAlert = <M>(h: HtmlBuilder<M>, failure: Failure): Html =>
  alertText(h, failureText(failure))

export const loadingText = <M>(h: HtmlBuilder<M>, text: string): Html =>
  h.p([h.Role('status'), h.Class('text-lg text-msf-grey')], [text])

// NOTE: never throws: a time no date can hold reads as an unknown time.
export const formatMoment = (epochMs: number): string => {
  try {
    return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
  } catch {
    return 'an unknown time'
  }
}
