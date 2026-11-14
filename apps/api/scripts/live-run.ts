import { Effect, Layer, Result } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
// Drives a whole pilot path over HTTP against one deployment, the way the
// browser does (the real RPC client, the session cookie, the image route).
// Stage 10 uses it for the log test and the CPU measurements on a test
// environment of the pilot stack. Started through `live-run.mjs`, which bundles
// it (the domain package is TypeScript with extensionless imports).
//
//   node apps/api/scripts/live-run.mjs pilot <base> --admin-link-file <f> --out <dir> [--tick-secret-file <f>]
//       one report through every step, with invented marker text and names;
//       writes markers.json (every invented string) and calls-pilot.json
//   node apps/api/scripts/live-run.mjs load <base> --out <dir> --reports <n> --deadline-minutes <m>
//       (after `pilot`, reusing its accounts) <n> more reports published to
//       the two reviewers with a near deadline, each section read and saved
//       several times, so the notification pass has work; writes calls-load.json
//
// <base> is http://127.0.0.1:<port> (local workerd) or a test Worker
// (https://test-<name>-pilot.<subdomain>.workers.dev). Anything else is
// refused: never the pilot, the demo or an iteration Worker.
//
// calls-<mode>.json lists each HTTP request: the procedure (or route), the status,
// the `cf-ray` of the answer and the client's start and end times, so the
// Worker's invocation events can be joined to the procedure. Nothing here
// prints a token, a password or the invented content.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

import {
  INTAKE_TEMPLATE,
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  QuoroomPublicRpcs,
  QuoroomRpcs,
  canonicalJson,
} from '@case-desk/domain'

import { sha256Hex } from '../src/quoroom/content.ts'
import { makePng } from '../src/quoroom/imageFixtures.ts'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    'admin-link-file': { type: 'string' },
    'tick-secret-file': { type: 'string' },
    out: { type: 'string' },
    reports: { type: 'string', default: '6' },
    'deadline-minutes': { type: 'string', default: '14' },
    repeat: { type: 'string', default: '3' },
  },
})
const [mode, baseArgument] = positionals
const base = (baseArgument ?? '').replace(/\/$/, '')
if (
  (mode !== 'pilot' && mode !== 'load') ||
  !/^(http:\/\/127\.0\.0\.1:\d+|https:\/\/test-[a-z0-9]+-pilot\.[a-z0-9-]+\.workers\.dev)$/.test(
    base,
  ) ||
  values.out === undefined
) {
  console.error(
    'Usage: live-run.mjs pilot|load <http://127.0.0.1:PORT | https://test-NAME-pilot.SUB.workers.dev> --out <dir> ...',
  )
  process.exit(2)
}
const out = values.out ?? ''
mkdirSync(out, { recursive: true })

// ---- Invented strings ------------------------------------------------------------------------

// NOTE: random-looking words that occur nowhere else, so a search of the logs
// for them can only find what this run sent.
const syllables = [
  'zel',
  'vor',
  'quas',
  'tle',
  'brin',
  'dax',
  'mor',
  'phy',
  'kel',
  'wen',
  'yth',
  'oru',
  'sib',
  'nax',
  'tov',
]
const word = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  const text = Array.from(
    bytes,
    byte => syllables[byte % syllables.length],
  ).join('')
  return text.charAt(0).toUpperCase() + text.slice(1)
}
const run = crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36) ?? 'x'
const markers: Array<string> = []
const mark = <T extends string>(text: T): T => {
  markers.push(text)
  return text
}
const marker = (what: string) =>
  mark(`${what}-marker-${run}-${word().toLowerCase()}`)
const fullName = () => mark(`${word()} ${word()}`)

const PASSWORD = 'synthetic-pass-1234'

// ---- HTTP with a cookie per person, recording each call ----------------------------------------

type Call = {
  op: string
  status: number
  ray: string | null
  // NOTE: on a test stage with invocation logs, the isolate and the number of
  // the request in it (`x-isolate`, `x-seq`), to tell warm requests from cold.
  isolate: string | null
  seq: number | null
  start: number
  end: number
}
const calls: Array<Call> = []
let currentOp = 'none'

type Person = {
  key: string
  email: string
  name: string
  cookie?: string | undefined
  id?: string
}

const fetchFor =
  (person: Person | undefined): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init)
    if (person?.cookie !== undefined)
      request.headers.set('cookie', person.cookie)
    const start = Date.now()
    const response = await fetch(request)
    calls.push({
      op: currentOp,
      status: response.status,
      ray: response.headers.get('cf-ray'),
      isolate: response.headers.get('x-isolate'),
      seq:
        response.headers.get('x-seq') === null
          ? null
          : Number(response.headers.get('x-seq')),
      start,
      end: Date.now(),
    })
    const set = response.headers.get('set-cookie')
    if (person !== undefined && set !== null) {
      const pair = set.split(';')[0] ?? ''
      // NOTE: a cleared cookie (sign-out) ends the session here too.
      person.cookie = pair.endsWith('=') ? undefined : pair
    }
    return response
  }

const protocol = (path: string, person: Person | undefined) =>
  RpcClient.layerProtocolHttp({ url: `${base}${path}` }).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFor(person))),
  )

const makeSigned = RpcClient.make(QuoroomRpcs)
const makePublic = RpcClient.make(QuoroomPublicRpcs)
type Signed = Effect.Success<typeof makeSigned>
type Public = Effect.Success<typeof makePublic>

const opName = (program: { toString(): string }) =>
  /c\.([A-Z][A-Za-z]+)\(/.exec(program.toString())?.[1] ?? 'rpc'

const attempt = <A, E>(
  person: Person,
  program: (client: Signed) => Effect.Effect<A, E>,
) => {
  currentOp = opName(program)
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(makeSigned, client => Effect.result(program(client))),
    ).pipe(Effect.provide(protocol(QUOROOM_RPC_PATH, person))) as Effect.Effect<
      Result.Result<A, E>
    >,
  )
}

const call = async <A, E>(
  person: Person,
  program: (client: Signed) => Effect.Effect<A, E>,
): Promise<A> => {
  const result = await attempt(person, program)
  if (Result.isFailure(result)) {
    // NOTE: the tag only; an error could echo what was sent.
    throw new Error(
      `${person.key}: ${currentOp} failed with ${(result.failure as { _tag?: string })._tag ?? 'unknown'}`,
    )
  }
  return result.success
}

const refused = async <A, E>(
  person: Person,
  program: (client: Signed) => Effect.Effect<A, E>,
): Promise<string> => {
  const result = await attempt(person, program)
  if (Result.isSuccess(result))
    throw new Error(`${person.key}: ${currentOp} was not refused`)
  return (result.failure as { _tag?: string })._tag ?? 'unknown'
}

const publicCall = async <A, E>(
  person: Person,
  program: (client: Public) => Effect.Effect<A, E>,
) => {
  currentOp = opName(program)
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(makePublic, client => Effect.result(program(client))),
    ).pipe(
      Effect.provide(protocol(QUOROOM_PUBLIC_PATH, person)),
    ) as Effect.Effect<Result.Result<A, E>>,
  )
}

const raw = (
  person: Person | undefined,
  op: string,
  path: string,
  init?: RequestInit,
) => {
  currentOp = op
  return fetchFor(person)(`${base}${path}`, init)
}

const activate = async (person: Person, token: string) => {
  const result = await publicCall(person, c =>
    c.ConsumeLink({ token, password: PASSWORD }),
  )
  if (Result.isFailure(result) || person.cookie === undefined)
    throw new Error(`${person.key}: activation failed`)
  person.id = result.success.id
}

// ---- Content ------------------------------------------------------------------------------------

const paragraph = (text: string) => ({
  type: 'paragraph' as const,
  content: [{ type: 'text' as const, text }],
})
const docOf = (...texts: ReadonlyArray<string>) => ({
  type: 'doc' as const,
  content: texts.map(paragraph),
})

const fixture = JSON.parse(
  readFileSync(
    join(
      import.meta.dirname ?? '.',
      '../../../packages/e2e/fixtures/intake.content.json',
    ),
    'utf8',
  ),
) as { sections: Record<string, unknown> }

// NOTE: about 6 KB of text per rich-text item when `padding` is on (spike 3's
// sections were 7.6 KB of JSON), always with the invented strings in it.
const filler =
  'The committee reviewed the sequence of events described in the intake form and the supporting notes. '
const contentFor = (
  sectionId: string,
  texts: { line: string; names: ReadonlyArray<string> },
  padding: boolean,
) => {
  const section = structuredClone(fixture.sections[sectionId]) as unknown
  const replace = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('Synthetic text for ')) {
      return `${texts.line} (${texts.names.join(', ')})`
    }
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>
      if (object.type === 'rich_text') {
        const extra = padding
          ? Array.from(
              { length: 12 },
              (_, index) => `${filler.repeat(4)}${index}`,
            )
          : []
        return {
          type: 'rich_text',
          doc: docOf(
            `${texts.line}: ${texts.names.join(' and ')} spoke first.`,
            ...extra,
          ),
        }
      }
      return Object.fromEntries(
        Object.entries(object).map(([key, inner]) => [key, replace(inner)]),
      )
    }
    return value
  }
  return replace(section) as never
}

// ---- One report through the path -------------------------------------------------------------

type World = {
  admin: Person
  authors: [Person, Person]
  reviewers: [Person, Person]
  unit: string
}

const deadline = (minutes: number) => ({
  at: Date.now() + minutes * 60_000,
  timeZone: 'Europe/Madrid',
})
const selections = (world: World) => [
  {
    roleId: 'committee',
    sources: world.reviewers.map(reviewer => ({
      kind: 'account' as const,
      accountId: reviewer.id ?? '',
    })),
  },
]

const shareAll = async (
  author: Person,
  reportId: string,
  counter: number,
  publish?: { minutes: number; world: World; closing: boolean },
) => {
  const outline = await call(author, c => c.GetWorkingCopy({ reportId }))
  const shareId = `share-${run}-${Math.random().toString(36).slice(2, 8)}`
  const hashes: Array<string> = []
  let peopleHash = ''
  let caseHash = ''
  for (const section of outline.sections) {
    const staged = await call(author, c =>
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
  const seen = await sha256Hex(`${hashes.join(',')}|${peopleHash}|${caseHash}`)
  const outcome = await call(author, c =>
    c.FinishShare({
      reportId,
      shareId,
      saveCounter: counter,
      redactionHash: seen,
      ...(publish === undefined
        ? {}
        : {
            publish: {
              deadline: deadline(publish.minutes),
              selections: selections(publish.world),
              closing: publish.closing,
            },
          }),
    }),
  )
  if (outcome.kind !== 'shared') throw new Error(`share was ${outcome.kind}`)
  return outcome.draft.number
}

// NOTE: what the browser does before it confirms: it reads the redacted text
// it shows and hashes it itself.
const confirmAndPublish = async (
  author: Person,
  world: World,
  reportId: string,
  draft: number,
  minutes: number,
  closing = false,
) => {
  const outline = await call(author, c =>
    c.GetDraftOutline({ reportId, draft }),
  )
  const hashes: Array<string> = []
  for (const section of outline.sections) {
    const shown = await call(author, c =>
      c.GetDraftSection({
        reportId,
        draft,
        sectionId: section.sectionId,
        view: 'redacted',
      }),
    )
    hashes.push(await sha256Hex(canonicalJson(shown.content)))
    await call(author, c =>
      c.GetDraftSection({
        reportId,
        draft,
        sectionId: section.sectionId,
        view: 'original',
      }),
    )
  }
  const people = await call(author, c => c.GetPeople({ reportId, draft }))
  const peopleHash = await sha256Hex(JSON.stringify(people.people))
  const caseHash = await sha256Hex(
    canonicalJson({
      title: outline.redactedCaseTitle ?? '',
      reference: outline.redactedCaseReference ?? '',
    }),
  )
  const redactedHash = await sha256Hex(
    `${hashes.join(',')}|${peopleHash}|${caseHash}`,
  )
  await call(author, c => c.ConfirmRedaction({ reportId, draft, redactedHash }))
  return call(author, c =>
    c.PublishRevision({
      reportId,
      draft,
      terms: {
        deadline: deadline(minutes),
        selections: selections(world),
        closing,
      },
    }),
  )
}
const readRevision = async (
  reviewer: Person,
  reportId: string,
  revision: number,
) => {
  const outline = await call(reviewer, c =>
    c.GetRevisionOutline({ reportId, revision }),
  )
  for (const section of outline.sections) {
    await call(reviewer, c =>
      c.GetRevisionSection({
        reportId,
        revision,
        sectionId: section.sectionId,
      }),
    )
  }
  return outline
}

const sendReview = async (
  reviewer: Person,
  reportId: string,
  revision: number,
  decision: 'approve' | 'request_changes' | 'comment',
) => {
  const pending = await call(reviewer, c =>
    c.GetPendingReview({ reportId, revision }),
  )
  return call(reviewer, c =>
    c.SendReview({
      reportId,
      revision,
      decision,
      commentIds: pending.comments.map(comment => comment.id),
    }),
  )
}

const SECTIONS = INTAKE_TEMPLATE.sections
  .map(section => section.id)
  .filter(id => id !== 'committee-conclusion')

const newReport = async (world: World, padding: boolean) => {
  const [alice, bob] = world.authors
  const people = [
    {
      id: 'person-1',
      name: fullName(),
      label: 'Person A',
      aliases: [mark(word())],
    },
    {
      id: 'person-2',
      name: fullName(),
      label: 'Person B',
      aliases: [mark(word())],
    },
  ]
  const names = people.map(person => person.name)
  const summary = await call(alice, c =>
    c.CreateReport({
      unit: world.unit,
      caseFile: {
        reference: marker('ref'),
        title: `${marker('title')} about ${names[0]}`,
      },
      templateId: INTAKE_TEMPLATE.id,
      templateVersion: INTAKE_TEMPLATE.version,
    }),
  )
  const reportId = summary.id
  await call(alice, c => c.AddCoAuthor({ reportId, accountId: bob.id ?? '' }))
  const started = await call(alice, c => c.StartWorkingCopy({ reportId }))
  let counter = (
    await call(alice, c =>
      c.SavePeople({ reportId, saveCounter: started.saveCounter, people }),
    )
  ).saveCounter
  for (const sectionId of SECTIONS) {
    const content = contentFor(
      sectionId,
      { line: marker(`section-${sectionId}`), names },
      padding,
    )
    counter = (
      await call(alice, c =>
        c.SaveSection({ reportId, sectionId, saveCounter: counter, content }),
      )
    ).saveCounter
    await call(alice, c => c.GetWorkingCopySection({ reportId, sectionId }))
  }
  return { reportId, counter, names }
}

const pilotPath = async (world: World) => {
  const [alice, bob] = world.authors
  const [carol, dan] = world.reviewers
  const { reportId, counter, names } = await newReport(world, false)

  // NOTE: an image in the summary, marked safe, so the redacted views carry it.
  const png = makePng([], 64)
  const imageId = `img-${run}`
  const upload = await raw(
    alice,
    'image-upload',
    `/api/images?uploadId=${imageId}&owner=${reportId}&index=0&chunks=1&mime=image%2Fpng&width=1&height=1&size=${png.length}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: png,
    },
  )
  if (upload.status !== 200) throw new Error(`image upload ${upload.status}`)
  const caption = marker('caption')
  let saveCounter = (
    await call(alice, c =>
      c.SaveSection({
        reportId,
        sectionId: 'summary',
        saveCounter: counter,
        content: {
          values: {
            'summary-text': {
              type: 'rich_text',
              doc: {
                type: 'doc',
                content: [
                  paragraph(`${marker('summary')}: ${names.join(' and ')}.`),
                  {
                    type: 'figure',
                    attrs: { imageId, alt: marker('alt'), safeToShare: true },
                    content: [{ type: 'text', text: caption }],
                  },
                ],
              },
            },
          },
          sections: {},
        } as never,
      }),
    )
  ).saveCounter
  await call(alice, c =>
    c.MarkImageSafe({ reportId, imageId, safe: true, saveCounter }),
  )
  saveCounter = (await call(alice, c => c.GetWorkingCopy({ reportId })))
    .saveCounter

  // Draft 1, a draft comment between the authors, Revision 1.
  const draft1 = await shareAll(alice, reportId, saveCounter)
  await call(bob, c =>
    c.AddDraftComment({
      reportId,
      draft: draft1,
      anchor: { kind: 'section', sectionId: 'summary' },
      body: marker('draft-comment'),
    }),
  )
  await call(bob, c => c.ListDraftComments({ reportId, draft: draft1 }))
  await confirmAndPublish(alice, world, reportId, draft1, 24 * 60)
  const requested = await awaitNotifications(carol)

  // The reviewers: inbox, reading, comments in both visibilities, decisions.
  await call(carol, c => c.ListInbox({}))
  await readRevision(carol, reportId, 1)
  const image = await raw(
    carol,
    'image-read',
    `/api/images/${imageId}/0?report=${reportId}&context=revision&revision=1`,
  )
  if (image.status !== 200) throw new Error(`image read ${image.status}`)
  const phraseSource = `${names[0]}`
  await call(carol, c =>
    c.AddComment({
      reportId,
      revision: 1,
      anchor: { kind: 'section', sectionId: 'summary' },
      body: `${marker('authors-comment')} ${phraseSource}`,
      visibility: 'authors',
    }),
  )
  await call(carol, c =>
    c.AddComment({
      reportId,
      revision: 1,
      anchor: { kind: 'section', sectionId: 'allegations' },
      body: marker('committee-comment'),
      visibility: 'committee',
    }),
  )
  await sendReview(carol, reportId, 1, 'request_changes')
  await call(dan, c => c.ListReviewerComments({ reportId, revision: 1 }))
  const comments = await call(alice, c =>
    c.ListRevisionComments({ reportId, revision: 1 }),
  )
  const first = comments[0]
  if (first !== undefined) {
    await call(alice, c =>
      c.ReplyToComment({
        reportId,
        commentId: first.id,
        body: marker('reply'),
      }),
    )
    await call(alice, c =>
      c.ResolveComment({ reportId, commentId: first.id, resolved: true }),
    )
  }

  // Revision 2: approved by both, so the round is decided by its rule.
  const copy = await call(alice, c => c.StartWorkingCopy({ reportId }))
  const saved = await call(alice, c =>
    c.SaveSection({
      reportId,
      sectionId: 'summary',
      saveCounter: copy.saveCounter,
      content: {
        values: {
          'summary-text': {
            type: 'rich_text',
            doc: docOf(`${marker('summary-v2')} ${names[1]}`),
          },
        },
        sections: {},
      } as never,
    }),
  )
  const draft2 = await shareAll(alice, reportId, saved.saveCounter)
  await confirmAndPublish(alice, world, reportId, draft2, 24 * 60)
  for (const reviewer of world.reviewers) {
    await readRevision(reviewer, reportId, 2)
    await sendReview(reviewer, reportId, 2, 'approve')
  }

  // The error paths: a refused review and a refused save, a sign-in with a
  // wrong password for an invented address, a malformed RPC body.
  const refusals = [
    await refused(dan, c =>
      c.SendReview({
        reportId,
        revision: 1,
        decision: 'approve',
        commentIds: [],
      }),
    ),
    await refused(carol, c =>
      c.SaveSection({
        reportId,
        sectionId: 'summary',
        saveCounter: 1,
        content: {
          values: {
            'summary-text': {
              type: 'rich_text',
              doc: docOf(marker('refused-save')),
            },
          },
          sections: {},
        } as never,
      }),
    ),
  ]
  const stranger: Person = {
    key: 'stranger',
    email: `${marker('stranger').toLowerCase()}@case-desk.test`,
    name: '',
  }
  const signIn = await publicCall(stranger, c =>
    c.SignIn({ email: stranger.email, password: marker('wrong-password') }),
  )
  if (Result.isSuccess(signIn)) throw new Error('a wrong password signed in')
  const malformed = await raw(alice, 'malformed-rpc', QUOROOM_RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      _tag: 'Request',
      id: '1',
      tag: 'SaveSection',
      payload: { reportId, junk: marker('malformed-body') },
      headers: [],
    }),
  })
  const brokenJson = await raw(alice, 'broken-json', QUOROOM_RPC_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"_tag":"Request","payload":"${marker('broken-json')}"`,
  })

  // The conclusion, the closing revision, archived.
  await call(alice, c => c.StartConclusion({ reportId }))
  const closingCopy = await call(alice, c => c.StartWorkingCopy({ reportId }))
  const conclusion = await call(alice, c =>
    c.SaveSection({
      reportId,
      sectionId: 'committee-conclusion',
      saveCounter: closingCopy.saveCounter,
      content: contentFor(
        'committee-conclusion',
        { line: marker('conclusion'), names },
        false,
      ),
    }),
  )
  const draft3 = await shareAll(alice, reportId, conclusion.saveCounter)
  await confirmAndPublish(alice, world, reportId, draft3, 24 * 60, true)
  for (const reviewer of world.reviewers) {
    await readRevision(reviewer, reportId, 3)
    await sendReview(reviewer, reportId, 3, 'approve')
  }
  const state = (await call(alice, c => c.GetReport({ reportId }))).summary
    .state
  const decided = await awaitNotifications(alice)

  // What the PDFs and the downloads read, the grid and the audit.
  await call(alice, c => c.GetDownloads({ reportId }))
  await call(alice, c => c.GetApprovalRecordData({ reportId }))
  // NOTE: a reviewer's PDF is made from the revision sections already read,
  // the template version and the theme.
  const closing = await call(carol, c =>
    c.GetRevisionOutline({ reportId, revision: 3 }),
  )
  await call(carol, c =>
    c.GetTemplateVersion({
      templateId: closing.templateId,
      version: closing.templateVersion,
      reportId,
      revision: 3,
    }),
  )
  await call(carol, c => c.GetTheme())
  await call(alice, c => c.GetTheme())
  await call(alice, c => c.GetGrid({ reportId }))
  await call(alice, c =>
    c.ListAuditEvents({ subject: { kind: 'report', reportId }, limit: 100 }),
  )
  await call(alice, c => c.GetHistory({ reportId }))

  return {
    reportId,
    state,
    notifications: { requested, decided },
    refusals,
    signIn: signIn.failure._tag,
    malformed: malformed.status,
    brokenJson: brokenJson.status,
  }
}

// ---- Accounts --------------------------------------------------------------------------------

const worldFile = join(out, 'world.json')

const makeWorld = async (adminToken: string): Promise<World> => {
  const admin: Person = { key: 'admin', email: '', name: '' }
  await activate(admin, adminToken)
  const unit = await call(admin, c =>
    c.CreateUnit({
      name: `${word()} unit`,
      code: `U${run.slice(0, 6).toUpperCase()}`,
    }),
  )
  const person = (key: string): Person => {
    const name = fullName()
    return { key, name, email: `${key}-${run}@case-desk.test` }
  }
  const authors: [Person, Person] = [person('alice'), person('bob')]
  for (const author of authors) {
    const granted = await call(admin, c =>
      c.GrantCapability({
        email: author.email,
        name: author.name,
        capability: 'author',
        unit: unit.id,
      }),
    )
    if (granted.link === undefined) throw new Error('no link for an author')
    await activate(author, granted.link.token)
  }
  const reviewers: [Person, Person] = [person('carol'), person('dan')]
  for (const reviewer of reviewers) {
    const added = await call(authors[0], c =>
      c.AddReviewer({
        unit: unit.id,
        name: reviewer.name,
        email: reviewer.email,
        whatsappConsent: false,
      }),
    )
    if (added.link === undefined) throw new Error('no link for a reviewer')
    await activate(reviewer, added.link.token)
  }
  return { admin, authors, reviewers, unit: unit.id }
}

const signInAgain = async (person: Person) => {
  const result = await publicCall(person, c =>
    c.SignIn({ email: person.email, password: PASSWORD }),
  )
  if (Result.isFailure(result)) throw new Error(`${person.key}: sign-in failed`)
}

const tick = async () => {
  if (values['tick-secret-file'] === undefined) return undefined
  const secret = readFileSync(values['tick-secret-file'], 'utf8').trim()
  const response = await raw(undefined, 'tick', '/api/tick', {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  })
  return response.status
}

// NOTE: the notification pass: on Cloudflare the Cron Trigger runs it every
// minute; with a tick secret (local workerd) `/api/tick` runs it at once. Waits
// until the person has an inbox item, reads the count and marks them read.
const awaitNotifications = async (person: Person) => {
  const until = Date.now() + 12 * 60_000
  for (;;) {
    await tick()
    const page = await call(person, c => c.ListNotifications({ limit: 50 }))
    if (page.items.length > 0) {
      await call(person, c => c.GetUnreadCount())
      await call(person, c =>
        c.MarkNotificationsRead({ ids: page.items.map(item => item.id) }),
      )
      return page.items.length
    }
    if (Date.now() > until)
      throw new Error(`${person.key}: no notification within 12 minutes`)
    await new Promise(resolve => setTimeout(resolve, 15_000))
  }
}

const save = (name: string, value: unknown) =>
  writeFileSync(join(out, name), JSON.stringify(value, null, 1), {
    mode: 0o600,
  })

try {
  if (mode === 'pilot') {
    const link = readFileSync(values['admin-link-file'] ?? '', 'utf8')
    const token = /\/link#([0-9a-f]{64})/.exec(link)?.[1]
    if (token === undefined) throw new Error('no activation link in the file')
    const world = await makeWorld(token)
    // NOTE: no session cookie is kept on disk; `load` signs in again.
    const strip = (person: Person): Person => ({ ...person, cookie: undefined })
    save('world.json', {
      ...world,
      admin: strip(world.admin),
      authors: world.authors.map(strip),
      reviewers: world.reviewers.map(strip),
    })
    const result = await pilotPath(world)
    await call(world.authors[1], c => c.SignOut())
    await signInAgain(world.authors[1])
    console.log(
      JSON.stringify({
        ...result,
        reportId: undefined,
        markers: markers.length,
        calls: calls.length,
      }),
    )
  } else {
    const world = JSON.parse(readFileSync(worldFile, 'utf8')) as World
    for (const person of [...world.authors, ...world.reviewers])
      await signInAgain(person)
    const reports = Number(values.reports)
    const minutes = Number(values['deadline-minutes'])
    const repeat = Number(values.repeat)
    const ids: Array<string> = []
    for (let index = 0; index < reports; index += 1) {
      const { reportId, counter } = await newReport(world, true)
      const [alice] = world.authors
      // NOTE: more saves and reads of the same sections, for the warm numbers.
      let saveCounter = counter
      for (let round = 0; round < repeat; round += 1) {
        for (const sectionId of SECTIONS) {
          const content = contentFor(
            sectionId,
            { line: marker(`again-${sectionId}`), names: ['Person A'] },
            true,
          )
          saveCounter = (
            await call(alice, c =>
              c.SaveSection({ reportId, sectionId, saveCounter, content }),
            )
          ).saveCounter
        }
      }
      const draft = await shareAll(alice, reportId, saveCounter)
      await confirmAndPublish(alice, world, reportId, draft, minutes + index)
      for (const reviewer of world.reviewers) {
        await call(reviewer, c => c.ListInbox({}))
        for (let round = 0; round < repeat; round += 1)
          await readRevision(reviewer, reportId, 1)
        await call(reviewer, c =>
          c.AddComment({
            reportId,
            revision: 1,
            anchor: { kind: 'section', sectionId: 'summary' },
            body: marker('load-comment'),
            visibility: 'committee',
          }),
        )
        await call(reviewer, c => c.GetUnreadCount())
      }
      // NOTE: one reviewer sends, the other stays silent, so the deadline
      // decides the round and the pass has reminders and a decision to send.
      await sendReview(world.reviewers[0], reportId, 1, 'comment')
      await call(alice, c => c.GetGrid({ reportId }))
      ids.push(reportId)
    }
    console.log(
      JSON.stringify({
        reports: ids.length,
        markers: markers.length,
        calls: calls.length,
      }),
    )
  }
} finally {
  const previous = (() => {
    try {
      return JSON.parse(
        readFileSync(join(out, 'markers.json'), 'utf8'),
      ) as Array<string>
    } catch {
      return []
    }
  })()
  save('markers.json', [...previous, ...markers])
  save(`calls-${mode}.json`, calls)
}
