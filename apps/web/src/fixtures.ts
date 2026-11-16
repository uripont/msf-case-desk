import { Option } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { fromString } from 'foldkit/url'

import {
  type AppConfig,
  DEFAULT_THEME,
  MeView,
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
  profile: { notifyOnApproval: false },
})

export const ORIGIN = 'https://quoroom.test'

export const urlOf = (path: string) =>
  Option.getOrThrow(fromString(`${ORIGIN}${path}`))

export const CONFIG: AppConfig = { theme: DEFAULT_THEME }

export const PAGE_PATHS = {
  Home: '/',
  Account: '/account',
  Unit: '/reports/unit',
  Reports: '/reports',
  People: '/people',
} as const

export const clickedLinkTo = (path: string): Message =>
  Message.ClickedLink({ request: UrlRequest.Internal({ url: urlOf(path) }) })

export const clickedPage = (page: keyof typeof PAGE_PATHS): Message =>
  clickedLinkTo(PAGE_PATHS[page])

export const openedAt = (path: string) => init(urlOf(path))

// NOTE: the app at an address, with its configuration known and no one signed
// in yet, as when the settings arrive before the session check.
export const configuredAt = (path: string, config: AppConfig = CONFIG) =>
  update(openedAt(path).model, Message.SucceededLoadConfig({ config })).model

export const configuredModel = configuredAt('/')

// NOTE: signed in, with the settings known, for Story and Scene tests that
// start from a working app.
export const signedInModel = update(
  configuredModel,
  Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
).model

export const signedOutModel = update(
  configuredModel,
  Message.FailedCheckSession(),
).model

export const atPage = (
  model: typeof initialModel,
  page: keyof typeof PAGE_PATHS,
) => update(model, clickedPage(page)).model
