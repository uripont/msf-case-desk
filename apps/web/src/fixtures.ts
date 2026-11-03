import { SEED_CASES, UserId } from '@case-desk/domain'

import { Message, initialModel, update } from './main'

export const SYNTHETIC_USER = {
  id: UserId.make('user-1'),
  email: 'tester@case-desk.test',
  name: 'Synthetic Tester',
}

// NOTE: signed in, with the synthetic seed cases loaded, for Story and Scene
// tests that start from a working desk.
export const signedInModel = update(
  initialModel,
  Message.SucceededCheckSession({ user: SYNTHETIC_USER }),
).model

export const loadedModel = update(
  signedInModel,
  Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
).model

export const signedOutModel = update(
  initialModel,
  Message.FailedCheckSession(),
).model
