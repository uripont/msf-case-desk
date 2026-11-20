import { Option, Redacted } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  CONFIG,
  SYNTHETIC_ME,
  clickedLinkTo,
  configuredAt,
  openedAt,
  urlOf,
} from './fixtures'
import {
  LoadConfig,
  LoadExternal,
  Message,
  PushUrl,
  ReplaceUrl,
  Session,
  SignIn,
  update,
} from './main'
import { ADMIN_ME } from './quoroom.fixtures'
import * as People from './quoroom/people'
import { Failure } from './quoroom/failure'
import * as Link from './quoroom/link'
import * as Review from './quoroom/review'
import {
  AppRoute,
  pathOf,
  redactedFragmentOf,
  urlToAppRoute,
  withoutFragment,
} from './route'

const routeOf = (path: string) => urlToAppRoute(urlOf(path))

const namesOf = (step: ReturnType<typeof update>): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const argsOf = (step: ReturnType<typeof update>, name: string) =>
  step.commands?.find(command => command.name === name)?.args

describe('routes', () => {
  test('each address opens its screen', () => {
    expect(routeOf('/')).toEqual(AppRoute.Home())
    expect(routeOf('/account')).toEqual(AppRoute.Account())
    expect(routeOf('/reports/unit')).toEqual(AppRoute.Unit())
    expect(routeOf('/people')).toEqual(AppRoute.People())
    expect(routeOf('/link')).toEqual(AppRoute.Link())
    expect(routeOf('/r/rep-1')).toEqual(AppRoute.Report({ reportId: 'rep-1' }))
    expect(routeOf('/r/rep-1/rev/3')).toEqual(
      AppRoute.Revision({ reportId: 'rep-1', revision: 3 }),
    )
    expect(routeOf('/r/rep-1/grid')).toEqual(AppRoute.Grid({ reportId: 'rep-1' }))
    expect(routeOf('/r/rep-1/audit')).toEqual(AppRoute.Audit({ reportId: 'rep-1' }))
    expect(routeOf('/r/rep-1/downloads')).toEqual(
      AppRoute.Downloads({ reportId: 'rep-1' }),
    )
  })

  test('an address with no screen is not found, and keeps its path', () => {
    expect(routeOf('/nothing/here')).toEqual(
      AppRoute.NotFound({ path: '/nothing/here' }),
    )
    expect(routeOf('/r/rep-1/rev/third')._tag).toBe('NotFound')
    expect(routeOf('/new-case')._tag).toBe('NotFound')
    expect(routeOf('/rules')._tag).toBe('NotFound')
  })

  test('every route prints the address that parses back to it', () => {
    const routes = [
      AppRoute.Home(),
      AppRoute.Account(),
      AppRoute.Unit(),
      AppRoute.People(),
      AppRoute.Link(),
      AppRoute.Report({ reportId: 'rep-1' }),
      AppRoute.Revision({ reportId: 'rep-1', revision: 2 }),
      AppRoute.Grid({ reportId: 'rep-1' }),
      AppRoute.Audit({ reportId: 'rep-1' }),
      AppRoute.Downloads({ reportId: 'rep-1' }),
    ]
    routes.forEach(route => {
      expect(routeOf(pathOf(route))).toEqual(route)
    })
  })
})

describe('opening the app at an address', () => {
  test('the screen of the address is the first screen, and the origin is kept', () => {
    const opened = openedAt('/r/rep-1/rev/2')
    expect(opened.model.route).toEqual(
      AppRoute.Revision({ reportId: 'rep-1', revision: 2 }),
    )
    expect(opened.model.origin).toBe('https://quoroom.test')
    expect(namesOf(opened)).toContain(LoadConfig.name)
  })
})

describe('a deep link opened signed out', () => {
  const link = '/r/rep-1/rev/2'

  test('asks for a sign-in, keeps the address, and is on that screen once signed in', () => {
    const deepLink = AppRoute.Revision({ reportId: 'rep-1', revision: 2 })
    story(
      update,
      given(openedAt(link).model),
      message(Message.SucceededLoadConfig({ config: CONFIG })),
      message(Message.FailedCheckSession()),
      model(next => {
        expect(next.session).toEqual(Session.SignedOut())
        expect(next.route).toEqual(deepLink)
      }),
      message(Message.UpdatedLoginEmail({ value: SYNTHETIC_ME.email })),
      message(
        Message.UpdatedLoginPassword({ value: Redacted.make('synthetic-pw') }),
      ),
      message(Message.SubmittedLogin()),
      Command.resolve(SignIn, Message.SucceededSignIn({ me: SYNTHETIC_ME })),
      model(next => {
        expect(next.session._tag).toBe('SignedIn')
        expect(next.route).toEqual(deepLink)
      }),
      Command.resolve(
        Review.LoadReview,
        Review.Message.FailedLoadReview({
          scope: { reportId: 'rep-1', generation: 2 },
          failure: Failure.NotAllowed(),
        }),
      ),
    )
  })

  test('the address is not rewritten while signed out or when signing in', () => {
    const signedOut = update(configuredAt(link), Message.FailedCheckSession())
    expect(namesOf(signedOut)).toEqual([])
    const signedIn = update(
      signedOut.model,
      Message.SucceededSignIn({ me: SYNTHETIC_ME }),
    )
    expect(namesOf(signedIn)).not.toContain(PushUrl.name)
    expect(namesOf(signedIn)).not.toContain(ReplaceUrl.name)
  })

  test('a session that ends while using a screen returns to that screen', () => {
    const onPeople = update(
      update(
        configuredAt('/people'),
        Message.SucceededCheckSession({ me: ADMIN_ME }),
      ).model,
      Message.EndedSession(),
    ).model
    expect(onPeople.session._tag).toBe('SignedOut')
    expect(onPeople.route).toEqual(AppRoute.People())
    const back = update(onPeople, Message.SucceededSignIn({ me: ADMIN_ME }))
    expect(back.model.route).toEqual(AppRoute.People())
    const other = update(
      onPeople,
      Message.SucceededSignIn({ me: { ...ADMIN_ME, id: 'another-admin' } }),
    )
    expect(other.model.route).toEqual(AppRoute.People())
    expect(namesOf(other)).toContain('LoadPeople')
  })

  test('the settings and the session may arrive in either order, and the screen loads once', () => {
    const configFirst = update(
      update(
        openedAt('/people').model,
        Message.SucceededLoadConfig({ config: CONFIG }),
      ).model,
      Message.SucceededCheckSession({ me: ADMIN_ME }),
    )
    const sessionFirst = update(
      update(
        openedAt('/people').model,
        Message.SucceededCheckSession({ me: ADMIN_ME }),
      ).model,
      Message.SucceededLoadConfig({ config: CONFIG }),
    )
    const loads = (step: ReturnType<typeof update>) =>
      namesOf(step).filter(name => name === People.LoadPeople.name)
    expect(loads(configFirst)).toHaveLength(1)
    expect(loads(sessionFirst)).toHaveLength(1)
    const early = update(
      openedAt('/people').model,
      Message.SucceededCheckSession({ me: ADMIN_ME }),
    )
    expect(namesOf(early)).toEqual([])
  })
})

describe('keeping the address in step', () => {
  const signedIn = update(
    configuredAt('/'),
    Message.SucceededCheckSession({ me: ADMIN_ME }),
  ).model

  test('a link inside the app opens its screen and pushes the address', () => {
    const clicked = update(signedIn, clickedLinkTo('/people'))
    expect(clicked.model.route).toEqual(AppRoute.People())
    expect(argsOf(clicked, PushUrl.name)).toEqual({
      url: 'https://quoroom.test/people',
    })
    expect(namesOf(clicked)).toContain('LoadPeople')
  })

  test('the address that follows a push changes nothing more', () => {
    const clicked = update(signedIn, clickedLinkTo('/people')).model
    const echoed = update(clicked, Message.ChangedUrl({ url: urlOf('/people') }))
    expect(echoed.model).toBe(clicked)
    expect(echoed.commands).toBeUndefined()
  })

  test('the back button opens the earlier screen without pushing', () => {
    const onPeople = update(signedIn, clickedLinkTo('/people')).model
    const back = update(onPeople, Message.ChangedUrl({ url: urlOf('/') }))
    expect(back.model.route).toEqual(AppRoute.Home())
    expect(namesOf(back)).not.toContain(PushUrl.name)
  })

  test('a link to the screen already open does nothing', () => {
    const same = update(signedIn, clickedLinkTo('/'))
    expect(same.model).toBe(signedIn)
  })

  test('a link to another site leaves the app', () => {
    const request = UrlRequest.External({ href: 'https://example.org/' })
    const left = update(signedIn, Message.ClickedLink({ request }))
    expect(argsOf(left, LoadExternal.name)).toEqual({
      href: 'https://example.org/',
    })
  })

  test('signing out goes back to the start page', () => {
    const onPeople = update(signedIn, clickedLinkTo('/people')).model
    const out = update(onPeople, Message.ClickedSignOut())
    expect(out.model.route).toEqual(AppRoute.Home())
    expect(argsOf(out, ReplaceUrl.name)).toEqual({ url: '/' })
  })
})

describe('the link page', () => {
  test('a link address without a session needs none', () => {
    const opened = openedAt('/link#abc')
    expect(Option.isSome(opened.model.maybeLink)).toBe(true)
  })

  const tokenOf = (model: ReturnType<typeof openedAt>['model']) =>
    Option.map(model.maybeLink, link => Redacted.value(link.token))

  test('a new link opened while on the link page replaces the model, reads the new token and removes the fragment', () => {
    const first = openedAt('/link#token-one').model
    const typed = update(
      first,
      Message.GotLinkMessage({
        message: Link.Message.UpdatedPassword({
          value: Redacted.make('half typed password'),
        }),
      }),
    ).model
    expect(
      Option.map(typed.maybeLink, link => Redacted.value(link.password)),
    ).toEqual(Option.some('half typed password'))

    // NOTE: the address changes to the same page with another fragment; the
    // runtime's Message carries it apart and Redacted.
    const second = update(
      typed,
      Message.ChangedUrl({
        url: urlOf('/link'),
        fragment: Redacted.make('token-two'),
      }),
    )
    expect(tokenOf(second.model)).toEqual(Option.some('token-two'))
    expect(
      Option.map(second.model.maybeLink, link => Redacted.value(link.password)),
    ).toEqual(Option.some(''))
    expect(namesOf(second)).toEqual(
      expect.arrayContaining(['InspectLink', ReplaceUrl.name]),
    )
    expect(argsOf(second, ReplaceUrl.name)).toEqual({ url: '/link' })
    expect(JSON.stringify(second.commands)).not.toContain('token-two')
  })

  test('the same holds for a click on a link address that carries a token', () => {
    const first = openedAt('/link#token-one').model
    const second = update(
      first,
      Message.ClickedLink({
        request: UrlRequest.Internal({ url: urlOf('/link') }),
        fragment: Redacted.make('token-two'),
      }),
    )
    expect(tokenOf(second.model)).toEqual(Option.some('token-two'))
    expect(argsOf(second, ReplaceUrl.name)).toEqual({ url: '/link' })
  })

  test('the address without its fragment, which the app leaves behind, changes nothing', () => {
    const first = openedAt('/link#token-one').model
    const echoed = update(first, Message.ChangedUrl({ url: urlOf('/link') }))
    expect(echoed.model).toBe(first)
    expect(tokenOf(echoed.model)).toEqual(Option.some('token-one'))
  })

  test('the Messages of the runtime never carry the fragment as text', () => {
    const changed = Message.ChangedUrl({
      url: urlOf('/link'),
      fragment: Redacted.make('token-three'),
    })
    expect(JSON.stringify(changed)).not.toContain('token-three')
    expect(String(changed)).not.toContain('token-three')
  })
})

describe('splitting the address from its fragment', () => {
  test('the address loses the fragment and the fragment comes out Redacted', () => {
    const url = urlOf('/link#token-four')
    expect(Option.isNone(withoutFragment(url).hash)).toBe(true)
    expect(JSON.stringify(withoutFragment(url))).not.toContain('token-four')
    const fragment = redactedFragmentOf(url)
    expect(Option.map(fragment, value => Redacted.value(value))).toEqual(
      Option.some('token-four'),
    )
    expect(JSON.stringify(fragment)).not.toContain('token-four')
    expect(Option.isNone(redactedFragmentOf(urlOf('/link')))).toBe(true)
  })
})
