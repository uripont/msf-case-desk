import { Option, Redacted, Schema, pipe } from 'effect'
import { Route } from 'foldkit'
import { defineRouteUnion } from 'foldkit/route'
import { type Url } from 'foldkit/url'

// NOTE: One route per screen. The URL is the address of the screen, so a link
// opens the right one and the address bar follows the app. A route is a
// variant, a router and a line in `urlToAppRoute` and `pathOf`.
// Nothing in a URL is secret. A link token travels in the fragment of `/link`
// only, which the app removes once it has read it.

// ROUTE

export const AppRoute = defineRouteUnion({
  Home: {},
  Account: {},
  Unit: {},
  Reports: {},
  People: {},
  Theme: {},
  Templates: {},
  TemplateEditor: { templateId: Schema.String, version: Schema.Int },
  Inbox: {},
  Notifications: {},
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
  Downloads: { reportId: Schema.String },
  Revision: { reportId: Schema.String, revision: Schema.Int },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

const homeRouter = pipe(Route.root, Route.mapTo(AppRoute.Home))
const accountRouter = pipe(
  Route.literal('account'),
  Route.mapTo(AppRoute.Account),
)
// NOTE: The unit's reviewers and committees, a part of the Reports tab.
const unitRouter = pipe(
  Route.literal('reports'),
  Route.slash(Route.literal('unit')),
  Route.mapTo(AppRoute.Unit),
)
const reportsRouter = pipe(
  Route.literal('reports'),
  Route.mapTo(AppRoute.Reports),
)
const peopleRouter = pipe(
  Route.literal('people'),
  Route.mapTo(AppRoute.People),
)
const themeRouter = pipe(Route.literal('theme'), Route.mapTo(AppRoute.Theme))
const templatesRouter = pipe(
  Route.literal('templates'),
  Route.mapTo(AppRoute.Templates),
)
const templateEditorRouter = pipe(
  Route.literal('templates'),
  Route.slash(Route.string('templateId')),
  Route.slash(Route.literal('v')),
  Route.slash(Route.int('version')),
  Route.mapTo(AppRoute.TemplateEditor),
)
const inboxRouter = pipe(Route.literal('inbox'), Route.mapTo(AppRoute.Inbox))
const notificationsRouter = pipe(
  Route.literal('notifications'),
  Route.mapTo(AppRoute.Notifications),
)
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
const downloadsRouter = pipe(
  Route.literal('r'),
  Route.slash(Route.string('reportId')),
  Route.slash(Route.literal('downloads')),
  Route.mapTo(AppRoute.Downloads),
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
    homeRouter,
    accountRouter,
    unitRouter,
    reportsRouter,
    peopleRouter,
    themeRouter,
    templateEditorRouter,
    templatesRouter,
    inboxRouter,
    notificationsRouter,
    linkRouter,
    revisionRouter,
    commentsRouter,
    gridRouter,
    auditRouter,
    downloadsRouter,
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
    Home: () => homeRouter(),
    Account: () => accountRouter(),
    Unit: () => unitRouter(),
    Reports: () => reportsRouter(),
    People: () => peopleRouter(),
    Theme: () => themeRouter(),
    Templates: () => templatesRouter(),
    TemplateEditor: ({ templateId, version }) =>
      templateEditorRouter({ templateId, version }),
    Inbox: () => inboxRouter(),
    Notifications: () => notificationsRouter(),
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
    Downloads: ({ reportId }) => downloadsRouter({ reportId }),
    Revision: ({ reportId, revision }) =>
      revisionRouter({ reportId, revision }),
    NotFound: ({ path }) => path,
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
