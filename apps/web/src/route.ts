import { Option, Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion } from 'foldkit/route'
import { type Url } from 'foldkit/url'

// NOTE: One route per screen. The URL is the address of the screen, so a link
// opens the right one and the address bar follows the app. Stages 4 to 6 add
// their routes here (reports, drafts, the reviewer's revision): a route is a
// variant, a router and a line in `urlToAppRoute`, `pathOf` and `needsSession`.
// Nothing in a URL is secret. A link token travels in the fragment of `/link`
// only, which the app removes once it has read it.

// ROUTE

export const AppRoute = defineRouteUnion({
  Desk: {},
  NewCase: {},
  Rules: {},
  Account: {},
  Unit: {},
  Admin: {},
  Link: {},
  Report: { reportId: Schema.String },
  Revision: { reportId: Schema.String, revision: Schema.Int },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

const deskRouter = pipe(Route.root, Route.mapTo(AppRoute.Desk))
const newCaseRouter = pipe(
  Route.literal('new-case'),
  Route.mapTo(AppRoute.NewCase),
)
const rulesRouter = pipe(Route.literal('rules'), Route.mapTo(AppRoute.Rules))
const accountRouter = pipe(
  Route.literal('account'),
  Route.mapTo(AppRoute.Account),
)
const unitRouter = pipe(Route.literal('unit'), Route.mapTo(AppRoute.Unit))
const adminRouter = pipe(Route.literal('admin'), Route.mapTo(AppRoute.Admin))
const linkRouter = pipe(Route.literal('link'), Route.mapTo(AppRoute.Link))
const reportRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.mapTo(AppRoute.Report),
)
const revisionRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('rev')),
  Route.slash(Route.int('revision')),
  Route.mapTo(AppRoute.Revision),
)

export const urlToAppRoute = Route.parseUrlWithFallback(
  Route.oneOf(
    deskRouter,
    newCaseRouter,
    rulesRouter,
    accountRouter,
    unitRouter,
    adminRouter,
    linkRouter,
    revisionRouter,
    reportRouter,
  ),
  AppRoute.NotFound,
)

export const pathOf = (route: AppRoute): string =>
  AppRoute.match(route, {
    Desk: () => deskRouter(),
    NewCase: () => newCaseRouter(),
    Rules: () => rulesRouter(),
    Account: () => accountRouter(),
    Unit: () => unitRouter(),
    Admin: () => adminRouter(),
    Link: () => linkRouter(),
    Report: ({ reportId }) => reportRouter({ reportId }),
    Revision: ({ reportId, revision }) =>
      revisionRouter({ reportId, revision }),
    NotFound: ({ path }) => path,
  })

// NOTE: Every screen but the link page and the not-found page needs a signed-in
// account. A visitor who opens one of them signed out keeps the address, is
// shown the sign-in form, and is on that screen once signed in.
export const needsSession = (route: AppRoute): boolean =>
  AppRoute.match(route, {
    Desk: () => true,
    NewCase: () => true,
    Rules: () => true,
    Account: () => true,
    Unit: () => true,
    Admin: () => true,
    Link: () => false,
    Report: () => true,
    Revision: () => true,
    NotFound: () => false,
  })

// NOTE: The triage screens of iteration 2. They belong to the demo
// environment and are off in a pilot (D20).
export const isTriageRoute = (route: AppRoute): boolean =>
  AppRoute.match(route, {
    Desk: () => true,
    NewCase: () => true,
    Rules: () => true,
    Account: () => false,
    Unit: () => false,
    Admin: () => false,
    Link: () => false,
    Report: () => false,
    Revision: () => false,
    NotFound: () => false,
  })

export const originOf = (url: Url): string =>
  `${url.protocol}//${url.host}${Option.match(url.port, {
    onNone: () => '',
    onSome: port => `:${port}`,
  })}`

export const fragmentOf = (url: Url): Option.Option<string> =>
  Option.filter(url.hash, hash => hash.length > 0)
