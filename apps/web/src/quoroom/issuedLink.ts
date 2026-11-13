import { Effect, Redacted, Schema } from 'effect'
import { Html, HtmlBuilder } from 'foldkit/html'

import { type ActivationLink, LINK_PATH } from '@case-desk/domain'

import { fieldClassName, labelClassName } from '../style'
import { formatMoment, panel, smallButton } from './ui'

// NOTE: A one-time link, shown once to the person who issued it (D13). It is
// held in the Model as `Redacted`, so it never reaches a log or DevTools; the
// token is in the fragment, so it is never part of a request URL.
export const IssuedLink = Schema.Struct({
  purpose: Schema.Literals(['activate', 'reset']),
  name: Schema.String,
  url: Schema.Redacted(Schema.String),
  expiresAt: Schema.Int,
})
export type IssuedLink = typeof IssuedLink.Type

export const issuedLinkOf = (
  origin: string,
  name: string,
  link: ActivationLink,
): IssuedLink => ({
  purpose: link.purpose,
  name,
  url: Redacted.make(`${origin}${LINK_PATH}#${link.token}`),
  expiresAt: link.expiresAt,
})

export const copyToClipboard = (text: Redacted.Redacted<string>) =>
  Effect.tryPromise(() => navigator.clipboard.writeText(Redacted.value(text)))

export const issuedLinkPanel = <M>(
  h: HtmlBuilder<M>,
  link: IssuedLink,
  onCopy: M,
  onDismiss: M,
): Html =>
  panel(h, 'One-time link', [
    h.p(
      [h.Class('text-pretty text-lg text-msf-ink')],
      [
        `${link.purpose === 'activate' ? 'Activation' : 'Password reset'} link for ${link.name}. It is shown only once and works until ${formatMoment(link.expiresAt)}. Send it to them yourself.`,
      ],
    ),
    h.label(
      [h.Class(labelClassName), h.For('issued-link')],
      [
        'Link',
        h.input([
          h.Id('issued-link'),
          h.Type('text'),
          h.Readonly(true),
          h.Value(Redacted.value(link.url)),
          h.Class(fieldClassName),
        ]),
      ],
    ),
    h.div(
      [h.Class('flex flex-wrap gap-3')],
      [
        smallButton(h, 'Copy link', onCopy),
        smallButton(h, 'I have copied it', onDismiss),
      ],
    ),
  ])
