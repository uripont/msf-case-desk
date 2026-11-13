import { Option, Redacted, Schema, pipe } from 'effect'
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
  Reports: {},
  Admin: {},
  Inbox: {},
  Link: {},
  Report: { reportId: Schema.String },
  Share: { reportId: Schema.String },
  Names: { reportId: Schema.String },
  Publish: { reportId: Schema.String },
  Drafts: { reportId: Schema.String },
  Draft: { reportId: Schema.String, draft: Schema.Int },
  Comments: { reportId: Schema.String },
  Grid: { reportId: Schema.String },
  Audit: { reportId: Schema.String },
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
const reportsRouter = pipe(
  Route.literal('reports'),
  Route.mapTo(AppRoute.Reports),
)
const adminRouter = pipe(Route.literal('admin'), Route.mapTo(AppRoute.Admin))
const inboxRouter = pipe(Route.literal('inbox'), Route.mapTo(AppRoute.Inbox))
const linkRouter = pipe(Route.literal('link'), Route.mapTo(AppRoute.Link))
const reportRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.mapTo(AppRoute.Report),
)
const shareRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('share')),
  Route.mapTo(AppRoute.Share),
)
const namesRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('names')),
  Route.mapTo(AppRoute.Names),
)
const publishRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('publish')),
  Route.mapTo(AppRoute.Publish),
)
const draftsRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('drafts')),
  Route.mapTo(AppRoute.Drafts),
)
const draftRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('drafts')),
  Route.slash(Route.int('draft')),
  Route.mapTo(AppRoute.Draft),
)
const commentsRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('comments')),
  Route.mapTo(AppRoute.Comments),
)
const gridRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('grid')),
  Route.mapTo(AppRoute.Grid),
)
const auditRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('audit')),
  Route.mapTo(AppRoute.Audit),
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
    reportsRouter,
    adminRouter,
    inboxRouter,
    linkRouter,
    revisionRouter,
    commentsRouter,
    gridRouter,
    auditRouter,
    draftRouter,
    draftsRouter,
    shareRouter,
    namesRouter,
    publishRouter,
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
    Reports: () => reportsRouter(),
    Admin: () => adminRouter(),
    Inbox: () => inboxRouter(),
    Link: () => linkRouter(),
    Report: ({ reportId }) => reportRouter({ reportId }),
    Share: ({ reportId }) => shareRouter({ reportId }),
    Names: ({ reportId }) => namesRouter({ reportId }),
    Publish: ({ reportId }) => publishRouter({ reportId }),
    Drafts: ({ reportId }) => draftsRouter({ reportId }),
    Draft: ({ reportId, draft }) => draftRouter({ reportId, draft }),
    Comments: ({ reportId }) => commentsRouter({ reportId }),
    Grid: ({ reportId }) => gridRouter({ reportId }),
    Audit: ({ reportId }) => auditRouter({ reportId }),
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
    Reports: () => true,
    Admin: () => true,
    Inbox: () => true,
    Link: () => false,
    Report: () => true,
    Share: () => true,
    Names: () => true,
    Publish: () => true,
    Drafts: () => true,
    Draft: () => true,
    Comments: () => true,
    Grid: () => true,
    Audit: () => true,
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
    Reports: () => false,
    Admin: () => false,
    Inbox: () => false,
    Link: () => false,
    Report: () => false,
    Share: () => false,
    Names: () => false,
    Publish: () => false,
    Drafts: () => false,
    Draft: () => false,
    Comments: () => false,
    Grid: () => false,
    Audit: () => false,
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

// NOTE: A Message never carries a fragment: the runtime hands over the whole
// URL, and the fragment of `/link` is the token. So the entry point splits it
// off before the Message is made: the Message gets the address without it, and
// the token apart, `Redacted`, so the Message history and DevTools never show it.
export const withoutFragment = (url: Url): Url => ({
  ...url,
  hash: Option.none(),
})

export const redactedFragmentOf = (
  url: Url,
): Option.Option<Redacted.Redacted<string>> =>
  Option.map(fragmentOf(url), fragment => Redacted.make(fragment))
