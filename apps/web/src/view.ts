import { clsx } from 'clsx'
import { Array, Option } from 'effect'
import { Document, Html, HtmlBuilder } from 'foldkit/html'

import { type MeView } from '@quoroom/domain'

import { PRODUCT_NAME } from './brand'
import { loginPage } from './loginView'
import {
  ConfigLoad,
  LEAVE_HEADING_ID,
  Message,
  type Model,
  PAGE_HEADING_ID,
  Session,
  themeOf,
} from './main'
import * as Account from './quoroom/account'
import * as Audit from './quoroom/audit'
import * as Comments from './quoroom/comments'
import * as Downloads from './quoroom/downloads'
import { actionButton } from './quoroom/entryViews'
import * as Grid from './quoroom/grid'
import * as History from './quoroom/history'
import * as Inbox from './quoroom/inbox'
import * as Link from './quoroom/link'
import * as Names from './quoroom/names'
import * as Notifications from './quoroom/notifications'
import * as People from './quoroom/people'
import * as Publish from './quoroom/publish'
import * as Report from './quoroom/report'
import * as Reports from './quoroom/reports'
import * as Review from './quoroom/review'
import * as Share from './quoroom/share'
import * as TemplateEditor from './quoroom/templateEditor'
import * as Templates from './quoroom/templates'
import * as ThemeScreen from './quoroom/themeScreen'
import * as Unit from './quoroom/unit'
import { AppRoute, pathOf } from './route'
import { focusRing, textButtonClassName } from './style'
import { themeStyle } from './theme'

// VIEW

const wordmark = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex items-center gap-4 pb-2 md:pb-3')],
    [
      Option.match(model.maybeLogoSrc, {
        onNone: () => h.empty,
        onSome: src =>
          h.img([
            h.Src(src),
            h.Alt(`${themeOf(model).organisationName} logo`),
            h.Class('block h-10 w-auto'),
          ]),
      }),
      h.p(
        [
          h.Class(
            'flex flex-wrap items-baseline gap-x-3 text-xl font-black tracking-tight text-msf-black',
          ),
        ],
        [
          PRODUCT_NAME,
          h.span(
            [h.Class('text-base font-normal text-msf-grey')],
            [themeOf(model).organisationName],
          ),
        ],
      ),
    ],
  )

const hasCapability = (
  me: MeView,
  capability: MeView['grants'][number]['capability'],
): boolean => Array.some(me.grants, grant => grant.capability === capability)

type Tab = 'home' | 'reports' | 'templates' | 'people' | 'theme'
type PageLink = { route: AppRoute; tab: Tab; label: string }

// NOTE: One tab per permission, shown only to whoever holds it; Home is for
// everyone and holds the inbox and the notifications.
const pageLinksFor = (
  me: MeView,
  unread: number,
): ReadonlyArray<PageLink> => [
  {
    route: AppRoute.Home(),
    tab: 'home',
    label: Notifications.unreadLabel('Home', unread),
  },
  ...(hasCapability(me, 'author')
    ? [{ route: AppRoute.Reports(), tab: 'reports' as const, label: 'Reports' }]
    : []),
  ...(hasCapability(me, 'template_editor')
    ? [
        {
          route: AppRoute.Templates(),
          tab: 'templates' as const,
          label: 'Templates',
        },
      ]
    : []),
  ...(hasCapability(me, 'people')
    ? [{ route: AppRoute.People(), tab: 'people' as const, label: 'People' }]
    : []),
  ...(hasCapability(me, 'theme')
    ? [{ route: AppRoute.Theme(), tab: 'theme' as const, label: 'Theme' }]
    : []),
]

const tabOf = (route: AppRoute): Option.Option<Tab> =>
  AppRoute.match<Option.Option<Tab>>(route, {
    Home: () => Option.some('home'),
    Inbox: () => Option.some('home'),
    Notifications: () => Option.some('home'),
    Revision: () => Option.some('home'),
    Reports: () => Option.some('reports'),
    Unit: () => Option.some('reports'),
    Report: () => Option.some('reports'),
    Share: () => Option.some('reports'),
    Names: () => Option.some('reports'),
    Publish: () => Option.some('reports'),
    Drafts: () => Option.some('reports'),
    Draft: () => Option.some('reports'),
    Comments: () => Option.some('reports'),
    Grid: () => Option.some('reports'),
    Audit: () => Option.some('reports'),
    Downloads: () => Option.some('reports'),
    Templates: () => Option.some('templates'),
    TemplateEditor: () => Option.some('templates'),
    People: () => Option.some('people'),
    Theme: () => Option.some('theme'),
    Account: () => Option.none(),
    Link: () => Option.none(),
    NotFound: () => Option.none(),
  })

const pageLink = (
  model: Model,
  { route, tab, label }: PageLink,
  h: HtmlBuilder<Message>,
): Html => {
  const isExact = pathOf(model.route) === pathOf(route)
  const isInTab = Option.contains(tabOf(model.route), tab)
  return h.a(
    [
      h.Href(pathOf(route)),
      h.Class(
        clsx(
          'cursor-pointer text-base transition-colors',
          focusRing,
          isInTab
            ? 'font-medium text-msf-black underline decoration-msf-red decoration-2 underline-offset-[6px]'
            : 'text-msf-grey hover:text-msf-ink',
        ),
      ),
      ...(isExact ? [h.AriaCurrent('page')] : isInTab ? [h.AriaCurrent('true')] : []),
    ],
    [label],
  )
}

const accountBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  Session.match(model.session, {
    Checking: () => h.empty,
    SignedOut: () => h.empty,
    SignedIn: ({ me }) =>
      h.div(
        [
          h.Class(
            'flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pt-4 text-sm text-msf-grey',
          ),
        ],
        [
          h.nav(
            [h.AriaLabel('Pages'), h.Class('flex flex-wrap gap-x-6 gap-y-2')],
            Array.map(
              pageLinksFor(me, model.notifications.unread),
              link => pageLink(model, link, h),
            ),
          ),
          h.div(
            [h.Class('flex items-baseline gap-x-4')],
            [
              h.a(
                [
                  h.Href(pathOf(AppRoute.Account())),
                  h.AriaLabel(`${me.name}, my account`),
                  ...(AppRoute.guards.Account(model.route)
                    ? [h.AriaCurrent('page')]
                    : []),
                  h.Class(clsx(textButtonClassName, focusRing)),
                ],
                [me.name],
              ),
              h.button(
                [
                  h.Class(textButtonClassName),
                  h.OnClick(Message.ClickedSignOut()),
                ],
                ['Sign out'],
              ),
            ],
          ),
        ],
      ),
  })

const topBar = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.header(
    [],
    [
      accountBar(model, h),
      h.div(
        [
          h.Class(
            'flex flex-col gap-x-12 border-b border-msf-line pt-5 md:flex-row md:items-end md:justify-between md:pt-6',
          ),
        ],
        [wordmark(model, h)],
      ),
    ],
  )

const footer = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.footer(
    [
      h.Class(
        'mt-24 flex flex-col gap-3 border-t border-msf-line pb-12 pt-8 md:mt-32',
      ),
    ],
    [
      h.p(
        [h.Class('max-w-3xl text-base leading-relaxed text-msf-ink')],
        [
          `${PRODUCT_NAME}, a reporting system for ${themeOf(model).organisationName}.`,
        ],
      ),
      h.p(
        [h.Class('max-w-3xl text-sm leading-relaxed text-msf-grey')],
        [
          'A prototype developed at Universitat Pompeu Fabra as part of our Project Management course.',
        ],
      ),
    ],
  )

const statusMessage = (
  title: string,
  body: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel('Status'),
      h.Class('flex flex-col items-start gap-4 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [
      h.h1(
        [
          h.Class(
            'max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
          ),
        ],
        [title],
      ),
      h.p(
        [h.Class('max-w-2xl text-pretty text-xl font-light text-msf-ink')],
        [body],
      ),
    ],
  )

const welcomeHeading = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('flex flex-col items-start gap-4')],
    [
      h.h1(
        [
          h.Id(PAGE_HEADING_ID),
          h.Class(
            'max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
          ),
        ],
        [`Welcome to ${PRODUCT_NAME}`],
      ),
      h.p(
        [h.Class('max-w-2xl text-pretty text-xl font-light text-msf-ink')],
        [
          `Reports for ${themeOf(model).organisationName} are written, reviewed and approved here.`,
        ],
      ),
    ],
  )

const welcomePage = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.section(
    [
      h.AriaLabel('Welcome'),
      h.Class('flex flex-col items-start gap-4 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [welcomeHeading(model, h)],
  )

// NOTE: Home: what waits for you to review, what happened, and for an author
// the way to their reports.
const homePage = (
  model: Model,
  me: MeView,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel('Home'),
      h.Class('flex max-w-3xl flex-col gap-10 pb-14 pt-12 md:pt-16'),
    ],
    [
      welcomeHeading(model, h),
      hasCapability(me, 'author')
        ? h.a(
            [
              h.Href(pathOf(AppRoute.Reports())),
              h.Class(clsx('text-lg', textButtonClassName)),
            ],
            ['Your reports'],
          )
        : h.empty,
      h.submodel({
        slotId: 'inbox',
        model: model.inbox,
        view: Inbox.view,
        toParentMessage: message => Message.GotInboxMessage({ message }),
      }),
      h.submodel({
        slotId: 'notifications',
        model: model.notifications,
        view: Notifications.view,
        toParentMessage: message =>
          Message.GotNotificationsMessage({ message }),
      }),
    ],
  )

const LEAVE_REASONS: Readonly<
  Record<ReturnType<typeof Report.unsavedReason>, string>
> = {
  offline:
    'You are offline. What you typed is saved when the connection returns.',
  failed: 'The last save did not work.',
  stale:
    'The working copy changed in another tab, so what you typed here is not saved.',
  saving: 'The last changes are being saved.',
}

// NOTE: Asks before the report is left with edits that are not saved (stage
// 4 review): stay, wait for the save and then go, or go without it.
const TEMPLATE_LEAVE_REASONS = {
  stale:
    'The draft was changed by someone else, so what you typed here is not saved.',
  unsaved: 'The draft has changes that are not saved.',
} as const

const leaveDialog = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.maybeLeaving, {
    onNone: () => h.empty,
    onSome: leaving => {
      const isTemplate = AppRoute.guards.TemplateEditor(model.route)
      const reason = isTemplate
        ? TemplateEditor.SaveState.guards.Stale(model.templateEditor.save)
          ? 'stale'
          : 'failed'
        : Report.unsavedReason(model.report)
      const what = isTemplate ? 'template' : 'report'
      return h.section(
        [
          h.AriaLabel(`Leave the ${what}?`),
          h.Role('alertdialog'),
          h.Class(
            'mb-6 mt-6 flex max-w-4xl flex-col gap-3 border-2 border-msf-ink px-4 py-4',
          ),
        ],
        [
          h.h2(
            [
              h.Id(LEAVE_HEADING_ID),
              h.Tabindex(-1),
              h.Class('text-xl font-black'),
            ],
            [`This ${what} has changes that are not saved`],
          ),
          h.p(
            [h.Class('text-pretty text-base text-msf-ink')],
            [
              `${isTemplate ? TEMPLATE_LEAVE_REASONS[reason === 'stale' ? 'stale' : 'unsaved'] : LEAVE_REASONS[reason]} If you leave now, they are lost.`,
            ],
          ),
          leaving.isWaiting
            ? h.p(
                [h.Role('status'), h.Class('text-base text-msf-grey')],
                ['Waiting for the save. You leave as soon as it is done.'],
              )
            : h.empty,
          h.div(
            [h.Class('flex flex-wrap gap-2')],
            [
              actionButton(
                h,
                `Stay on this ${what}`,
                `Stay on this ${what}`,
                Message.ClickedStayOnReport(),
              ),
              reason === 'stale' || leaving.isWaiting
                ? h.empty
                : actionButton(
                    h,
                    'Wait for the save, then leave',
                    'Wait for the save, then leave',
                    Message.ClickedWaitToLeaveReport(),
                  ),
              actionButton(
                h,
                'Leave without saving',
                'Leave without saving',
                Message.ClickedLeaveReportUnsaved(),
              ),
            ],
          ),
        ],
      )
    },
  })

const unavailablePage = (
  title: string,
  body: string,
  h: HtmlBuilder<Message>,
): Html =>
  h.section(
    [
      h.AriaLabel(title),
      h.Class('flex flex-col items-start gap-4 pb-14 pt-12 md:pb-20 md:pt-16'),
    ],
    [
      h.h1(
        [
          h.Id(PAGE_HEADING_ID),
          h.Class(
            'max-w-4xl text-balance text-4xl font-black leading-[1.05] tracking-[-0.025em] text-msf-black sm:text-5xl',
          ),
        ],
        [title],
      ),
      h.p(
        [h.Class('max-w-2xl text-pretty text-xl font-light text-msf-ink')],
        [body],
      ),
      h.a(
        [
          h.Href(pathOf(AppRoute.Home())),
          h.Class(clsx('text-base', textButtonClassName)),
        ],
        ['Go to the start page'],
      ),
    ],
  )

const accountPage = (model: Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'account',
    model: model.account,
    view: Account.view,
    toParentMessage: message => Message.GotAccountMessage({ message }),
  })

const pageView = (
  model: Model,
  me: MeView,
  h: HtmlBuilder<Message>,
): ReadonlyArray<Html> =>
  AppRoute.match<ReadonlyArray<Html>>(model.route, {
        Home: () => [homePage(model, me, h)],
        Account: () => [accountPage(model, h)],
        Unit: () => [
          h.submodel({
            slotId: 'unit',
            model: model.unit,
            view: Unit.view,
            toParentMessage: message => Message.GotUnitMessage({ message }),
          }),
        ],
        People: () => [
          h.submodel({
            slotId: 'people',
            model: model.people,
            view: People.view,
            toParentMessage: message => Message.GotPeopleMessage({ message }),
          }),
        ],
        Theme: () => [
          h.submodel({
            slotId: 'theme',
            model: model.themeScreen,
            view: ThemeScreen.view,
            toParentMessage: message =>
              Message.GotThemeScreenMessage({ message }),
          }),
        ],
        Templates: () => [
          h.submodel({
            slotId: 'templates',
            model: model.templates,
            view: Templates.view,
            toParentMessage: message =>
              Message.GotTemplatesMessage({ message }),
          }),
        ],
        TemplateEditor: ({ templateId, version }) => [
          h.submodel({
            slotId: `template-${templateId}-${version}`,
            model: model.templateEditor,
            view: TemplateEditor.view,
            toParentMessage: message =>
              Message.GotTemplateEditorMessage({ message }),
          }),
        ],
        Link: () => [welcomePage(model, h)],
        Reports: () => [
          h.submodel({
            slotId: 'reports',
            model: model.reports,
            view: Reports.view,
            toParentMessage: message => Message.GotReportsMessage({ message }),
          }),
        ],
        Report: ({ reportId }) => [
          leaveDialog(model, h),
          h.submodel({
            slotId: `report-${reportId}`,
            model: model.report,
            view: Report.view,
            toParentMessage: message => Message.GotReportMessage({ message }),
          }),
        ],
        Share: ({ reportId }) => [
          h.submodel({
            slotId: `share-${reportId}`,
            model: model.share,
            view: Share.view,
            toParentMessage: message => Message.GotShareMessage({ message }),
          }),
        ],
        Names: ({ reportId }) => [
          h.submodel({
            slotId: `names-${reportId}`,
            model: model.names,
            view: Names.view,
            toParentMessage: message => Message.GotNamesMessage({ message }),
          }),
        ],
        Publish: ({ reportId }) => [
          h.submodel({
            slotId: `publish-${reportId}`,
            model: model.publish,
            view: Publish.view,
            toParentMessage: message => Message.GotPublishMessage({ message }),
          }),
        ],
        Drafts: ({ reportId }) => [
          h.submodel({
            slotId: `drafts-${reportId}`,
            model: model.history,
            view: History.view,
            toParentMessage: message => Message.GotHistoryMessage({ message }),
          }),
        ],
        Draft: ({ reportId, draft }) => [
          h.submodel({
            slotId: `draft-${reportId}-${draft}`,
            model: model.history,
            view: History.view,
            toParentMessage: message => Message.GotHistoryMessage({ message }),
          }),
        ],
        Inbox: () => [homePage(model, me, h)],
        Notifications: () => [homePage(model, me, h)],
        Comments: ({ reportId }) => [
          h.submodel({
            slotId: `comments-${reportId}`,
            model: model.comments,
            view: Comments.view,
            toParentMessage: message => Message.GotCommentsMessage({ message }),
          }),
        ],
        Grid: ({ reportId }) => [
          h.submodel({
            slotId: `grid-${reportId}`,
            model: model.grid,
            view: Grid.view,
            toParentMessage: message => Message.GotGridMessage({ message }),
          }),
        ],
        Audit: ({ reportId }) => [
          h.submodel({
            slotId: `audit-${reportId}`,
            model: model.audit,
            view: Audit.view,
            toParentMessage: message => Message.GotAuditMessage({ message }),
          }),
        ],
        Downloads: ({ reportId }) => [
          h.submodel({
            slotId: `downloads-${reportId}`,
            model: model.downloads,
            view: Downloads.view,
            toParentMessage: message =>
              Message.GotDownloadsMessage({ message }),
          }),
        ],
        Revision: ({ reportId, revision }) => [
          h.submodel({
            slotId: `rev-${reportId}-${revision}`,
            model: model.review,
            view: Review.view,
            toParentMessage: message => Message.GotReviewMessage({ message }),
          }),
        ],
        NotFound: () => [
          unavailablePage(
            'Page not found',
            'There is nothing at this address.',
            h,
          ),
        ],
      })

const linkView = (link: Link.Model, h: HtmlBuilder<Message>): Html =>
  h.submodel({
    slotId: 'link',
    model: link,
    view: Link.view,
    toParentMessage: message => Message.GotLinkMessage({ message }),
  })

const mainView = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
  Option.match(model.maybeLink, {
    onSome: link => [linkView(link, h)],
    onNone: () =>
      ConfigLoad.guards.Loading(model.config)
        ? [statusMessage(`Opening ${PRODUCT_NAME}`, 'Getting the settings.', h)]
        : Session.match(model.session, {
            Checking: () => [
              statusMessage(
                `Opening ${PRODUCT_NAME}`,
                'Checking your session.',
                h,
              ),
            ],
            SignedOut: () => [loginPage(model, h)],
            SignedIn: ({ me }) => pageView(model, me, h),
          }),
  })

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: PRODUCT_NAME,
  body: h.div(
    [
      h.Id('quoroom-root'),
      h.Class(
        'min-h-dvh border-t-[6px] border-msf-red bg-msf-paper font-sans text-msf-ink',
      ),
      h.Style(themeStyle(themeOf(model))),
    ],
    [
      h.div(
        [h.Class('mx-auto max-w-6xl px-5 sm:px-10')],
        [topBar(model, h), h.main([], mainView(model, h)), footer(model, h)],
      ),
    ],
  ),
})
