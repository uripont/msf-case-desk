import { Redacted } from 'effect'

import { MeView } from '@case-desk/domain'

import { SYNTHETIC_ME, loadedModel } from './fixtures'
import { Message, Place, initialModel, update } from './main'

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
    Message.CompletedReadLocation({
      origin: 'https://quoroom.test',
      place: Place.Elsewhere(),
    }),
  ].reduce((model, message) => update(model, message).model, initialModel)

export const adminModel = signedInAs(ADMIN_ME)

export const authorModel = signedInAs(AUTHOR_ME)

export const linkPageModel = (maybeToken: typeof Place.Type) =>
  update(
    initialModel,
    Message.CompletedReadLocation({
      origin: 'https://quoroom.test',
      place: maybeToken,
    }),
  ).model

export const desk = loadedModel
