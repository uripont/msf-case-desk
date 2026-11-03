import { SEED_CASES } from '@case-desk/domain'

import { Message, initialModel, update } from './main'

// NOTE: the Model after the synthetic seed cases have loaded, for Story and
// Scene tests that start from a working desk.
export const loadedModel = update(
  initialModel,
  Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
).model
