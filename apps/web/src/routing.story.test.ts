import { Option, Redacted } from 'effect'
import { UrlRequest } from 'foldkit/navigation'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  DEMO_CONFIG,
  PILOT_CONFIG,
  SYNTHETIC_ME,
  clickedLinkTo,
  configuredAt,
  openedAt,
  urlOf,
} from './fixtures'
import {
  LoadConfig,
  LoadDesk,
  LoadExternal,
  Message,
  PushUrl,
  ReplaceUrl,
  Session,
  SignIn,
  update,
} from './main'
import { ADMIN_ME, SYNTHETIC_UNIT } from './quoroom.fixtures'
import * as Admin from './quoroom/admin'
import { AppRoute, needsSession, pathOf, urlToAppRoute } from './route'

const routeOf = (path: string) => urlToAppRoute(urlOf(path))

const namesOf = (step: ReturnType<typeof update>): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const argsOf = (step: ReturnType<typeof update>, name: string) =>
  step.commands?.find(command => command.name === name)?.args

describe('routes', () => {
  test('each address opens its screen', () => {
    expect(routeOf('/')).toEqual(AppRoute.Desk())
    expect(routeOf('/new-case')).toEqual(AppRoute.NewCase())
    expect(routeOf('/rules')).toEqual(AppRoute.Rules())
    expect(routeOf('/account')).toEqual(AppRoute.Account())
    expect(routeOf('/unit')).toEqual(AppRoute.Unit())
    expect(routeOf('/admin')).toEqual(AppRoute.Admin())
    expect(routeOf('/link')).toEqual(AppRoute.Link())
    expect(routeOf('/r/rep-1')).toEqual(AppRoute.Report({ reportId: 'rep-1' }))
    expect(routeOf('/r/rep-1/rev/3')).toEqual(
      AppRoute.Revision({ reportId: 'rep-1', revision: 3 }),
    )
  })

  test('an address with no screen is not found, and keeps its path', () => {
    expect(routeOf('/nothing/here')).toEqual(
      AppRoute.NotFound({ path: '/nothing/here' }),
    )
    expect(routeOf('/r/rep-1/rev/third')._tag).toBe('NotFound')
  })

  test('every route prints the address that parses back to it', () => {
    const routes = [
      AppRoute.Desk(),
      AppRoute.NewCase(),
      AppRoute.Rules(),
      AppRoute.Account(),
      AppRoute.Unit(),
      AppRoute.Admin(),
      AppRoute.Link(),
      AppRoute.Report({ reportId: 'rep-1' }),
      AppRoute.Revision({ reportId: 'rep-1', revision: 2 }),
    ]
    routes.forEach(route => {
      expect(routeOf(pathOf(route))).toEqual(route)
    })
  })

  test('only the link page and the not-found page are open to a visitor', () => {
    expect(needsSession(AppRoute.Link())).toBe(false)
    expect(needsSession(AppRoute.NotFound({ path: '/x' }))).toBe(false)
    expect(
      needsSession(AppRoute.Revision({ reportId: 'r', revision: 1 })),
    ).toBe(true)
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
      message(Message.SucceededLoadConfig({ config: DEMO_CONFIG })),
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
        LoadDesk,
        Message.SucceededLoadDesk({ cases: [], ruleSets: [] }),
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
    const onAdmin = update(
      update(
        configuredAt('/admin'),
        Message.SucceededCheckSession({ me: ADMIN_ME }),
      ).model,
      Message.FailedLoadDesk({ failure: 'SignInRequired' }),
    ).model
    expect(onAdmin.session._tag).toBe('SignedOut')
    expect(onAdmin.route).toEqual(AppRoute.Admin())
    const back = update(onAdmin, Message.SucceededSignIn({ me: ADMIN_ME }))
    expect(back.model.route).toEqual(AppRoute.Admin())
    expect(namesOf(back)).toContain('LoadAdmin')
  })

  test('the settings and the session may arrive in either order, and the data loads once', () => {
    const configFirst = update(
      update(
        openedAt('/').model,
        Message.SucceededLoadConfig({ config: DEMO_CONFIG }),
      ).model,
      Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
    )
    const sessionFirst = update(
      update(
        openedAt('/').model,
        Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
      ).model,
      Message.SucceededLoadConfig({ config: DEMO_CONFIG }),
    )
    expect(
      namesOf(configFirst).filter(name => name === LoadDesk.name),
    ).toHaveLength(1)
    expect(
      namesOf(sessionFirst).filter(name => name === LoadDesk.name),
    ).toHaveLength(1)
    const early = update(
      openedAt('/').model,
      Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
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
    const clicked = update(signedIn, clickedLinkTo('/admin'))
    expect(clicked.model.route).toEqual(AppRoute.Admin())
    expect(argsOf(clicked, PushUrl.name)).toEqual({
      url: 'https://quoroom.test/admin',
    })
    expect(namesOf(clicked)).toContain('LoadAdmin')
  })

  test('the address that follows a push changes nothing more', () => {
    const clicked = update(signedIn, clickedLinkTo('/admin')).model
    const echoed = update(clicked, Message.ChangedUrl({ url: urlOf('/admin') }))
    expect(echoed.model).toBe(clicked)
    expect(echoed.commands).toBeUndefined()
  })

  test('the back button opens the earlier screen without pushing', () => {
    const onAdmin = update(signedIn, clickedLinkTo('/admin')).model
    const back = update(onAdmin, Message.ChangedUrl({ url: urlOf('/') }))
    expect(back.model.route).toEqual(AppRoute.Desk())
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
    const onAdmin = update(signedIn, clickedLinkTo('/admin')).model
    const out = update(onAdmin, Message.ClickedSignOut())
    expect(out.model.route).toEqual(AppRoute.Desk())
    expect(argsOf(out, ReplaceUrl.name)).toEqual({ url: '/' })
  })
})

describe('the pilot', () => {
  const pilotSignedIn = update(
    configuredAt('/', PILOT_CONFIG),
    Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
  )

  test('never loads the triage desk', () => {
    expect(namesOf(pilotSignedIn)).not.toContain(LoadDesk.name)
  })

  test('the demo does', () => {
    const demo = update(
      configuredAt('/', DEMO_CONFIG),
      Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
    )
    expect(namesOf(demo)).toContain(LoadDesk.name)
  })

  test('a settings failure counts as no triage rather than as the demo', () => {
    const failed = update(openedAt('/').model, Message.FailedLoadConfig())
    const signedIn = update(
      failed.model,
      Message.SucceededCheckSession({ me: SYNTHETIC_ME }),
    )
    expect(namesOf(signedIn)).not.toContain(LoadDesk.name)
  })

  test('the administration screen of a pilot still loads', () => {
    const adminPilot = update(
      update(
        openedAt('/admin').model,
        Message.SucceededLoadConfig({ config: PILOT_CONFIG }),
      ).model,
      Message.SucceededCheckSession({ me: ADMIN_ME }),
    )
    expect(namesOf(adminPilot)).toContain(Admin.LoadAdmin.name)
    expect(SYNTHETIC_UNIT.code).toBe('SYN')
  })
})

describe('the link page', () => {
  test('a link address without a session needs none', () => {
    const opened = openedAt('/link#abc')
    expect(Option.isSome(opened.model.maybeLink)).toBe(true)
  })
})
