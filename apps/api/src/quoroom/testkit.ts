import { Effect, Layer, Result } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'

import {
  DEFAULT_NOTIFICATION_CONFIG,
  canonicalJson,
  INTAKE_TEMPLATE,
  QuoroomRpcs,
  ReportRepository,
  type ReportRepositoryApi,
  Repository,
  type Template,
  UserId,
} from '@case-desk/domain'
import { makeMemoryReportRepository, makeMemoryRepository } from '@case-desk/domain/testing/memory'
import { PANEL_TEMPLATE } from '@case-desk/domain/testing/templates'

import { makeApp } from '../app'
import { makeSqlReportRepository } from '../reportRepository'
import { SESSION_COOKIE, hashToken } from '../session'
import type { SqlStatement, SqlStore } from '../sql'
import { makeNodeSqlite } from '../testing/nodeSqlite'
import { QuoroomConfig, makeTestClock, makeTestIds } from './core'
import { sha256Hex } from './content'
import { QUOROOM_RPC_PATH } from './server'

// NOTE: Test support for the Quoroom API: a world with a unit, accounts,
// grants and sessions, one built-in or invented template, and one client per
// person that talks to the real RPC handler stack (`makeApp`) over a fetch
// that goes straight into it. All data is invented.

export const U1 = 'unit-1'
export const U2 = 'unit-2'

export type Scenario = Readonly<{
  name: string
  template: Template
  backend: 'memory' | 'sqlite'
  // NOTE: the role ids of the template.
  authorsRole: string
  redactedRole: string
  fullRole?: string
  observerRole?: string
  // NOTE: a top-level section with one rich text item, for the tests.
  sectionId: string
  itemId: string
  conclusion?: Readonly<{ sectionId: string; itemId: string }>
}>

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: 'built-in intake template, in memory',
    template: INTAKE_TEMPLATE,
    backend: 'memory',
    authorsRole: 'authors',
    redactedRole: 'committee',
    sectionId: 'summary',
    itemId: 'summary-text',
    conclusion: { sectionId: 'committee-conclusion', itemId: 'conclusion-decision' },
  },
  {
    name: 'invented panel template, in memory',
    template: PANEL_TEMPLATE,
    backend: 'memory',
    authorsRole: 'drafters',
    redactedRole: 'members',
    fullRole: 'chair',
    observerRole: 'observer',
    sectionId: 'overview',
    itemId: 'overview-text',
  },
  {
    name: 'invented panel template, on SQLite',
    template: PANEL_TEMPLATE,
    backend: 'sqlite',
    authorsRole: 'drafters',
    redactedRole: 'members',
    fullRole: 'chair',
    observerRole: 'observer',
    sectionId: 'overview',
    itemId: 'overview-text',
  },
]

export const doc = (text: string) => ({
  type: 'doc' as const,
  content: [
    { type: 'paragraph' as const, content: [{ type: 'text' as const, text }] },
  ],
})

export const richContent = (itemId: string, text: string) => ({
  values: { [itemId]: { type: 'rich_text' as const, doc: doc(text) } },
  sections: {},
})

export const withFigure = (itemId: string, text: string, imageId: string, safe: boolean) => ({
  values: {
    [itemId]: {
      type: 'rich_text' as const,
      doc: {
        type: 'doc' as const,
        content: [
          ...doc(text).content,
          {
            type: 'figure' as const,
            attrs: { imageId, alt: 'A photo', safeToShare: safe },
          },
        ],
      },
    },
  },
  sections: {},
})

export const PEOPLE = [
  {
    id: 'ana-garcia',
    name: 'Ana Garcia',
    label: 'Person A',
    aliases: ['Ana'],
  },
]

export const SECRET = 'Ana Garcia'
export const TEXT = 'Ana Garcia reported the matter on Monday.'

// NOTE: `adam` is an administrator and `tess` a template editor: the
// deployment capabilities, with no part in any report.
const PEOPLE_ACCOUNTS = [
  ['alice', 'Alice Author', U1],
  ['bob', 'Bob Author', U1],
  ['carol', 'Carol Reviewer', null],
  ['dan', 'Dan Reviewer', null],
  ['erin', 'Erin Chair', null],
  ['ivy', 'Ivy Observer', null],
  ['frank', 'Frank Outsider', null],
  ['gina', 'Gina Other Unit', U2],
  ['adam', 'Adam Administrator', null, 'admin'],
  ['tess', 'Tess Template Editor', null, 'template_editor'],
] as const

export type PersonName = (typeof PEOPLE_ACCOUNTS)[number][0]

type PersonRow = readonly [string, string, string | null, ('admin' | 'template_editor')?]

const countingStatement = (
  statement: SqlStatement,
  count: () => void,
): SqlStatement => ({
  bind: (...values) => countingStatement(statement.bind(...values), count),
  all: () => {
    count()
    return statement.all()
  },
  first: () => {
    count()
    return statement.first()
  },
  run: () => {
    count()
    return statement.run()
  },
})

const makeClient = RpcClient.make(QuoroomRpcs)
export type Client = Effect.Success<typeof makeClient>

export const makeWorld = async (scenario: Scenario) => {
  let queries = 0
  let measure = true
  let worstRequest = 0
  const count = () => {
    queries += 1
  }
  let repository: ReportRepositoryApi
  if (scenario.backend === 'memory') {
    repository = await Effect.runPromise(makeMemoryReportRepository())
  } else {
    const raw = makeNodeSqlite()
    const store: SqlStore = {
      prepare: query => countingStatement(raw.prepare(query), count),
      batch: steps => {
        queries += steps.length
        return raw.batch(steps)
      },
    }
    repository = makeSqlReportRepository(store)
  }
  const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> =>
    Effect.runPromise(effect as Effect.Effect<A>)

  const users = await Effect.runPromise(makeMemoryRepository())
  const clock = makeTestClock(Date.UTC(2026, 10, 12, 9, 0, 0))
  const deps = Layer.mergeAll(
    Layer.succeed(ReportRepository, repository),
    clock.layer,
    makeTestIds(),
    Layer.succeed(QuoroomConfig, DEFAULT_NOTIFICATION_CONFIG),
  )
  const app = makeApp(Layer.succeed(Repository, users), deps)

  await run(
    repository.createUnit({ id: U1, name: 'Unit One', code: 'U1', createdAt: 1 }),
  )
  await run(
    repository.createUnit({ id: U2, name: 'Unit Two', code: 'U2', createdAt: 1 }),
  )
  const tokens = new Map<string, string>()
  for (const [id, name, unit, capability] of PEOPLE_ACCOUNTS as ReadonlyArray<PersonRow>) {
    const created = await run(
      repository.createAccount({
        id,
        email: `${id}@case-desk.test`,
        name,
        passwordHash: 'not-a-real-hash',
        profile: {
          phone: null,
          whatsappConsent: false,
          whatsappConsentAt: null,
          notifyOnApproval: false,
          active: true,
        },
        ...(unit !== null
          ? { grant: { capability: 'author' as const, unitId: unit } }
          : capability === undefined
            ? {}
            : { grant: { capability } }),
        createdBy: null,
        now: 1,
      }),
    )
    if (created._tag !== 'Created') throw new Error(`account ${id}`)
    const token = Array.from(`${id}`, ch => ch.charCodeAt(0).toString(16)).join('').padEnd(64, '0').slice(0, 64)
    tokens.set(id, token)
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* users.createUser({
          id: UserId.make(id),
          email: `${id}@case-desk.test`,
          name,
          passwordHash: 'not-a-real-hash',
        })
        yield* users.createSession({
          tokenHash: yield* Effect.promise(() => hashToken(token)),
          userId: UserId.make(id),
          createdAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
        })
      }),
    )
  }
  // NOTE: the reviewers of unit one are in its registry, as the unit's own
  // entries; frank is nobody's, and gina is a reviewer of unit two.
  for (const [id, name, unit] of [
    ['carol', 'Carol Reviewer', U1],
    ['dan', 'Dan Reviewer', U1],
    ['erin', 'Erin Chair', U1],
    ['ivy', 'Ivy Observer', U1],
  ] as const) {
    await run(
      repository.linkReviewer(
        unit,
        id,
        null,
        1,
        { at: 1, actorId: null, action: 'reviewer.linked' },
        { displayName: name, phone: null, consentRequested: false },
      ),
    )
  }
  await run(
    repository.importBuiltInTemplates(
      [
        {
          templateId: scenario.template.id,
          version: scenario.template.version,
          name: scenario.template.name,
          shortName: scenario.template.shortName,
          definition: JSON.stringify(scenario.template),
        },
      ],
      1,
    ),
  )

  const fetchFor =
    (who: string): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init)
      request.headers.set('cookie', `${SESSION_COOKIE}=${tokens.get(who)}`)
      const before = queries
      const response = await app.handle(request)
      if (measure) worstRequest = Math.max(worstRequest, queries - before)
      return response
    }

  const attempt = <A, E>(
    who: PersonName,
    program: (client: Client) => Effect.Effect<A, E>,
  ): Promise<Result.Result<A, E>> =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(makeClient, client => Effect.result(program(client))),
      ).pipe(
        Effect.provide(
          RpcClient.layerProtocolHttp({
            url: `https://desk.test${QUOROOM_RPC_PATH}`,
          }).pipe(
            Layer.provide(RpcSerialization.layerJson),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFor(who))),
          ),
        ),
      ) as Effect.Effect<Result.Result<A, E>>,
    )

  const call = async <A, E>(
    who: PersonName,
    program: (client: Client) => Effect.Effect<A, E>,
  ): Promise<A> => {
    const result = await attempt(who, program)
    if (Result.isFailure(result)) {
      throw new Error(`${who} failed: ${JSON.stringify(result.failure)}`)
    }
    return result.success
  }

  // NOTE: the error of a call that must fail, as its tag.
  const refused = async <A, E>(
    who: PersonName,
    program: (client: Client) => Effect.Effect<A, E>,
  ): Promise<E> => {
    const result = await attempt(who, program)
    if (Result.isSuccess(result)) {
      throw new Error(`${who} was not refused: ${JSON.stringify(result.success)} by ${program.toString()}`)
    }
    return result.failure
  }

  // NOTE: sends a review the way the send dialog does: the pending comments
  // are read first and their ids sent with the decision.
  const sendReview = async (
    who: PersonName,
    reportId: string,
    revision: number,
    decision: 'approve' | 'request_changes' | 'comment',
  ) => {
    const pending = await call(who, c => c.GetPendingReview({ reportId, revision }))
    return call(who, c =>
      c.SendReview({
        reportId,
        revision,
        decision,
        commentIds: pending.comments.map(comment => comment.id),
      }),
    )
  }

  const raw = (who: PersonName, path: string, init?: RequestInit) =>
    fetchFor(who)(`https://desk.test${path}`, init)

  const createReport = (who: PersonName = 'alice', unit = U1) =>
    call(who, client =>
      client.CreateReport({
        unit,
        caseFile: {
          reference: `REF-${unit}-${Math.random().toString(36).slice(2, 8)}`,
          title: `Case about ${SECRET}`,
        },
        templateId: scenario.template.id,
        templateVersion: scenario.template.version,
      }),
    ).then(summary => summary.id)

  // NOTE: save the people list and one section of the author's working copy,
  // share all of it and finish. Returns the outcome and the working copy's
  // save counter.
  const share = async (
    who: PersonName,
    reportId: string,
    options: {
      shareId: string
      sectionId?: string
      itemId?: string
      content?: ReturnType<typeof richContent>
      people?: typeof PEOPLE
      confirm?: boolean
    },
  ) => {
    const sectionId = options.sectionId ?? scenario.sectionId
    const itemId = options.itemId ?? scenario.itemId
    const started = await call(who, c => c.StartWorkingCopy({ reportId }))
    let counter = started.saveCounter
    if (options.people !== undefined) {
      const saved = await call(who, c =>
        c.SavePeople({ reportId, saveCounter: counter, people: options.people ?? [] }),
      )
      counter = saved.saveCounter
    }
    const saved = await call(who, c =>
      c.SaveSection({
        reportId,
        sectionId,
        saveCounter: counter,
        content: options.content ?? richContent(itemId, TEXT),
      }),
    )
    counter = saved.saveCounter
    return { counter, ...(await stageAndFinish(who, reportId, options.shareId, counter, options.confirm)) }
  }

  const stageAndFinish = async (
    who: PersonName,
    reportId: string,
    shareId: string,
    counter: number,
    confirm?: boolean,
    closing?: boolean,
  ) => {
    const outline = await call(who, c => c.GetWorkingCopy({ reportId }))
    const hashes: Array<string> = []
    let peopleHash = ''
    let caseHash = ''
    for (const section of outline.sections) {
      const staged = await call(who, c =>
        c.ShareSection({
          reportId,
          shareId,
          sectionId: section.sectionId,
          saveCounter: counter,
        }),
      )
      hashes.push(staged.redactedHash)
      peopleHash = staged.peopleHash
      caseHash = staged.caseHash
    }
    // NOTE: the redaction preview the author saw is the hash of the staged
    // redacted content and of the people list; the server checks it against
    // what is staged and what the working copy has.
    const seen =
      confirm === true
        ? await sha256Hex(`${hashes.join(',')}|${peopleHash}|${caseHash}`)
        : undefined
    const outcome = await call(who, c =>
      c.FinishShare({
        reportId,
        shareId,
        saveCounter: counter,
        ...(seen === undefined ? {} : { redactionHash: seen }),
        // NOTE: "share and publish" when `closing` is given.
        ...(closing === undefined
          ? {}
          : {
              publish: {
                deadline: deadline(),
                selections: selections(),
                closing,
              },
            }),
      }),
    )
    return { outcome }
  }

  const deadline = () => ({
    at: clock.now() + 7 * 24 * 3_600_000,
    timeZone: 'Europe/Madrid',
  })

  const selections = () => [
    ...(scenario.fullRole === undefined
      ? []
      : [
          {
            roleId: scenario.fullRole,
            sources: [{ kind: 'account' as const, accountId: 'erin' }],
          },
        ]),
    {
      roleId: scenario.redactedRole,
      sources: [
        { kind: 'account' as const, accountId: 'carol' },
        { kind: 'account' as const, accountId: 'dan' },
      ],
    },
    ...(scenario.observerRole === undefined
      ? []
      : [
          {
            roleId: scenario.observerRole,
            sources: [{ kind: 'account' as const, accountId: 'ivy' }],
          },
        ]),
  ]

  // NOTE: the author confirms the redaction preview of the draft, then
  // publishes it to everybody the scenario names.
  const publish = async (
    who: PersonName,
    reportId: string,
    draft: number,
    closing = false,
    deadlineAt?: number,
  ) => {
    // NOTE: what the browser does before it confirms: it reads the redacted
    // text it shows, the people list and the redacted case title and
    // reference of the staged draft, and hashes them itself. The hash is never
    // taken from the server's own header (`GetHistory`).
    const outline = await call(who, c => c.GetDraftOutline({ reportId, draft }))
    const hashes: Array<string> = []
    for (const section of outline.sections) {
      const shown = await call(who, c =>
        c.GetDraftSection({ reportId, draft, sectionId: section.sectionId, view: 'redacted' }),
      )
      hashes.push(await sha256Hex(canonicalJson(shown.content)))
    }
    const people = await call(who, c => c.GetPeople({ reportId, draft }))
    const peopleHash = await sha256Hex(JSON.stringify(people.people))
    const caseHash = await sha256Hex(
      canonicalJson({
        title: outline.redactedCaseTitle ?? '',
        reference: outline.redactedCaseReference ?? '',
      }),
    )
    const redactedHash = await sha256Hex(`${hashes.join(',')}|${peopleHash}|${caseHash}`)
    await call(who, c =>
      c.ConfirmRedaction({
        reportId,
        draft,
        redactedHash,
      }),
    )
    return call(who, c =>
      c.PublishRevision({
        reportId,
        draft,
        terms: {
          deadline: deadlineAt === undefined ? deadline() : { ...deadline(), at: deadlineAt },
          selections: selections(),
          closing,
        },
      }),
    )
  }

  // NOTE: a report with Draft 1 (with the people list and the section) shared
  // and published as Revision 1.
  const published = async () => {
    const reportId = await createReport()
    const { outcome } = await share('alice', reportId, {
      shareId: 'share-1',
      people: PEOPLE,
    })
    if (outcome.kind !== 'shared') throw new Error('not shared')
    const result = await publish('alice', reportId, outcome.draft.number)
    return { reportId, draft: outcome.draft, revision: result.revision }
  }

  return {
    scenario,
    repository,
    clock,
    app,
    call,
    attempt,
    sendReview,
    refused,
    raw,
    createReport,
    share,
    stageAndFinish,
    publish,
    published,
    deadline,
    selections,
    deps,
    queries: () => queries,
    worstRequest: () => worstRequest,
    measure: (on: boolean) => {
      measure = on
    },
    dispose: () => app.dispose(),
  }
}

export type World = Awaited<ReturnType<typeof makeWorld>>
