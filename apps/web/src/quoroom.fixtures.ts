import { Option, Redacted } from 'effect'

import { MeView } from '@case-desk/domain'

import {
  SYNTHETIC_ME,
  configuredAt,
  configuredModel,
  loadedModel,
} from './fixtures'
import { Message, update } from './main'

// NOTE: Synthetic accounts for the Quoroom screens. The link tokens are made
// up and match nothing.
export const SYNTHETIC_UNIT = {
  id: 'unit-1',
  name: 'Synthetic Unit',
  code: 'SYN',
}

export const SYNTHETIC_TOKEN = Redacted.make('0123456789abcdef0123456789abcdef')

export const withGrants = (grants: MeView['grants']): MeView =>
  MeView.make({ ...SYNTHETIC_ME, grants })

export const ADMIN_ME = withGrants([{ capability: 'admin' }])

export const AUTHOR_ME = withGrants([
  { capability: 'author', unit: SYNTHETIC_UNIT.id },
])

export const signedInAs = (me: MeView) =>
  [
    Message.SucceededCheckSession({ me }),
    Message.SucceededLoadDesk({ cases: [], ruleSets: [] }),
  ].reduce((model, message) => update(model, message).model, configuredModel)

export const adminModel = signedInAs(ADMIN_ME)

export const authorModel = signedInAs(AUTHOR_ME)

// NOTE: the app opened on a link address, with the token in the fragment as a
// real link has it, or none.
export const linkPageModel = (
  maybeToken: Option.Option<Redacted.Redacted<string>>,
) =>
  configuredAt(
    Option.match(maybeToken, {
      onNone: () => '/link',
      onSome: token => `/link#${Redacted.value(token)}`,
    }),
  )

export const desk = loadedModel
