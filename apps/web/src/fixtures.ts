import { Option } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { fromString } from 'foldkit/url'

import {
  type AppConfig,
  DEFAULT_THEME,
  MeView,
  SEED_CASES,
  UserId,
} from '@case-desk/domain'

import { Message, init, initialModel, update } from './main'

export const SYNTHETIC_USER = {
  id: UserId.make('user-1'),
  email: 'tester@case-desk.test',
  name: 'Synthetic Tester',
}

export const SYNTHETIC_ME = MeView.make({
  id: SYNTHETIC_USER.id,
  email: SYNTHETIC_USER.email,
  name: SYNTHETIC_USER.name,
  grants: [],
  profile: { whatsappConsent: false, notifyOnApproval: false },
})

export const ORIGIN = 'https://quoroom.test'

export const urlOf = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`))

export const DEMO_CONFIG: AppConfig = { mode: 'demo', theme: DEFAULT_THEME }
export const PILOT_CONFIG: AppConfig = { mode: 'pilot', theme: DEFAULT_THEME }

export const PAGE_PATHS = {
  Desk: '/',
  NewCase: '/new-case',
  Rules: '/rules',
  Account: '/account',
  Unit: '/unit',
  Admin: '/admin',
} as const

export const clickedLinkTo = (path: string): Message =>
  Message.ClickedLink({ request: UrlRequest.Internal({ url: urlOf(path) }) })

export const clickedPage = (page: keyof typeof PAGE_PATHS): Message =>
  clickedLinkTo(PAGE_PATHS[page])

export const openedAt = (path: string) => init(urlOf(path))

// NOTE: the app at an address, with its configuration known and no one signed
// in yet, as when the settings arrive before the session check.
export const configuredAt = (path: string, config: AppConfig = DEMO_CONFIG) =>
  update(openedAt(path).model, Message.SucceededLoadConfig({ config })).model

export const configuredModel = configuredAt('/')

// NOTE: signed in, with the settings known, for Story and Scene tests that
// start from a working app.
export const signedInModel = update(
  configuredModel,
  Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
).model

export const loadedModel = update(
  signedInModel,
  Message.SucceededLoadDesk({ cases: SEED_CASES, ruleSets: [] }),
).model

export const signedOutModel = update(
  configuredModel,
  Message.FailedCheckSession(),
).model

export const pilotSignedInModel = update(
  configuredAt('/', PILOT_CONFIG),
  Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
).model

export const atPage = (
  model: typeof initialModel,
  page: keyof typeof PAGE_PATHS,
) => update(model, clickedPage(page)).model
