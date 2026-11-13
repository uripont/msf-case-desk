import { Effect, Layer, Result } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { afterEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_NOTIFICATION_CONFIG,
  LINK_PATH as DOMAIN_LINK_PATH,
  QuoroomPublicRpcs,
  QuoroomRpcs,
  ReportRepository,
  Repository,
} from '@case-desk/domain'

import { makeApp } from './app'
import { makeSqlRepository } from './d1Repository'
import { environmentFile, grantAdminSql, isEnvironment } from './grantAdmin'
import { LINK_PATH, LINK_TTL_MS, sha256Hex } from './links'
import { makeSqlReportRepository } from './reportRepository'
import { hashToken } from './session'
import { makeNodeSqlite } from './testing/nodeSqlite'
import { QuoroomConfig, makeTestClock, makeTestIds } from './quoroom/core'
import { QUOROOM_PUBLIC_PATH, QUOROOM_RPC_PATH } from './quoroom/server'

// NOTE: D21 through the real stack: the generated SQL is run on SQLite with
// every migration, as an import of D1 or of the workerd database would, and
// then the link is used through the Worker's own routes. Invented people.

const NOW = Date.UTC(2026, 11, 1, 9, 0, 0)
const EMAIL = 'sam.synthetic@case-desk.test'

const makePublic = RpcClient.make(QuoroomPublicRpcs)
const makeSigned = RpcClient.make(QuoroomRpcs)

const open: Array<() => Promise<void>> = []
afterEach(async () => {
  await Promise.all(open.splice(0).map(dispose => dispose()))
})

const input = (token: string, mode: 'activate' | 'reset', id = 'a1') => ({
  email: EMAIL,
  name: 'Sam Synthetic',
  now: NOW,
  accountId: `acc-${id}`,
  invitationId: `inv-${token}`,
  importId: `imp-${token}`,
  tokenHash: `hash-of-${token}`,
  mode,
})

const world = () => {
  const sql = makeNodeSqlite()
  const clock = makeTestClock(NOW + 1000)
  const app = makeApp(
    Layer.succeed(Repository, makeSqlRepository(sql)),
    Layer.mergeAll(
      Layer.succeed(ReportRepository, makeSqlReportRepository(sql)),
      clock.layer,
      makeTestIds(),
      Layer.succeed(QuoroomConfig, DEFAULT_NOTIFICATION_CONFIG),
    ),
    'demo',
  )
  open.push(() => app.dispose())
  const jar = new Map<string, string>()
  const fetchFn: typeof fetch = async (request, init) => {
    const req = new Request(request, init)
    const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie !== '') req.headers.set('cookie', cookie)
    const response = await app.handle(req)
    response.headers.getSetCookie().forEach(line => {
      const [name = '', value = ''] = (line.split(';')[0] ?? '').split('=')
      jar.set(name, value)
    })
    return response
  }
  const layer = (path: string) =>
    RpcClient.layerProtocolHttp({ url: `https://desk.test${path}` }).pipe(
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
    )
  const publicCall = <A, E>(
    program: (client: Effect.Success<typeof makePublic>) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(makePublic, client => Effect.result(program(client))),
      ).pipe(Effect.provide(layer(QUOROOM_PUBLIC_PATH))) as Effect.Effect<
        Result.Result<A, E>
      >,
    )
  const signedCall = <A, E>(
    program: (client: Effect.Success<typeof makeSigned>) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(makeSigned, client => Effect.result(program(client))),
      ).pipe(Effect.provide(layer(QUOROOM_RPC_PATH))) as Effect.Effect<
        Result.Result<A, E>
      >,
    )
  return { sql, clock, jar, publicCall, signedCall }
}

const rows = (sql: ReturnType<typeof makeNodeSqlite>, query: string) =>
  sql.raw.prepare(query).all() as Array<Record<string, unknown>>

const issued = async (token: string, mode: 'activate' | 'reset', id = 'a1') => ({
  token,
  sql: grantAdminSql({
    ...input(token, mode, id),
    tokenHash: await sha256Hex(token),
  }),
})

describe('pnpm grant-admin (D21)', () => {
  test('the Node-safe constants match the ones the Worker uses', async () => {
    expect(LINK_PATH).toBe(DOMAIN_LINK_PATH)
    expect(await sha256Hex('a token')).toBe(await hashToken('a token'))
    expect(LINK_TTL_MS).toBe(72 * 3_600_000)
    expect(environmentFile('test-3')).toBe('grants-test-3.sql')
    expect(['demo', 'pilot', 'workerd', 'test-12'].every(isEnvironment)).toBe(
      true,
    )
    expect(['prod', 'test-', '../x', 'test-1; DROP'].some(isEnvironment)).toBe(
      false,
    )
  })

  test('creates an administrator and template editor with no password; the link sets one, once', async () => {
    const w = world()
    const token = 'f'.repeat(64)
    const { sql } = await issued(token, 'activate')
    w.sql.raw.exec(sql)
    expect(sql).not.toMatch(/password['"]?\s*[:=]/i)
    expect(rows(w.sql, 'SELECT email, password_hash FROM users')).toEqual([
      { email: EMAIL, password_hash: 'pbkdf2-sha256$0$!$!' },
    ])
    expect(
      rows(w.sql, 'SELECT capability, unit_id FROM capability_grants ORDER BY capability'),
    ).toEqual([
      { capability: 'admin', unit_id: '' },
      { capability: 'template_editor', unit_id: '' },
    ])

    const info = await w.publicCall(c => c.InspectLink({ token }))
    expect(Result.isSuccess(info) && info.success).toMatchObject({
      purpose: 'activate',
      name: 'Sam Synthetic',
      email: EMAIL,
    })
    const consumed = await w.publicCall(c =>
      c.ConsumeLink({ token, password: 'a long synthetic passphrase' }),
    )
    expect(Result.isSuccess(consumed) && consumed.success.grants).toEqual(
      expect.arrayContaining([
        { capability: 'admin' },
        { capability: 'template_editor' },
      ]),
    )
    const me = await w.signedCall(c => c.GetMe())
    expect(Result.isSuccess(me) && me.success.email).toBe(EMAIL)
    // NOTE: a used link fails.
    const again = await w.publicCall(c =>
      c.ConsumeLink({ token, password: 'another synthetic passphrase' }),
    )
    expect(Result.isFailure(again) && again.failure).toMatchObject({
      _tag: 'LinkInvalid',
    })
    expect(
      rows(w.sql, "SELECT action FROM audit_events WHERE action LIKE 'account.operator%'"),
    ).toEqual([{ action: 'account.operator_activation_issued' }])
  })

  test('running the same file again changes nothing, and never undoes a password', async () => {
    const w = world()
    const first = await issued('a'.repeat(64), 'activate')
    w.sql.raw.exec(first.sql)
    await w.publicCall(c =>
      c.ConsumeLink({ token: first.token, password: 'a long synthetic passphrase' }),
    )
    const before = rows(w.sql, 'SELECT * FROM users')
    const grantsBefore = rows(w.sql, 'SELECT * FROM capability_grants')
    // NOTE: the import re-runs the whole file on every start, and a second
    // `pnpm grant-admin` for the same email appends more statements.
    const second = await issued('b'.repeat(64), 'activate', 'a2')
    w.sql.raw.exec(first.sql + second.sql + first.sql)
    expect(rows(w.sql, 'SELECT * FROM users')).toEqual(before)
    expect(rows(w.sql, 'SELECT * FROM capability_grants')).toEqual(grantsBefore)
    expect(rows(w.sql, 'SELECT * FROM users')[0]?.['password_hash']).not.toBe(
      'pbkdf2-sha256$0$!$!',
    )
    // NOTE: an activation link for an account that has a password does not exist.
    expect(rows(w.sql, 'SELECT id FROM invitations')).toEqual([{ id: 'inv-' + 'a'.repeat(64) }])
    const stale = await w.publicCall(c => c.InspectLink({ token: second.token }))
    expect(Result.isFailure(stale)).toBe(true)
    expect(rows(w.sql, 'SELECT COUNT(*) AS n FROM audit_events WHERE action LIKE \'account.operator%\'')).toEqual([{ n: 1 }])
  })

  test('a block applies once: after a revocation a re-run does not grant again', async () => {
    const w = world()
    const { sql } = await issued('7'.repeat(64), 'activate')
    w.sql.raw.exec(sql)
    expect(rows(w.sql, 'SELECT capability FROM capability_grants')).toHaveLength(2)
    w.sql.raw.exec(`DELETE FROM capability_grants WHERE capability = 'template_editor'`)
    // NOTE: a redeploy or a restart of workerd imports the same file again.
    w.sql.raw.exec(sql)
    w.sql.raw.exec(sql)
    expect(rows(w.sql, 'SELECT capability FROM capability_grants')).toEqual([{ capability: 'admin' }])
    expect(rows(w.sql, 'SELECT id FROM applied_imports')).toEqual([{ id: 'imp-' + '7'.repeat(64) }])
  })

  test('a block applied twice without a revocation leaves one account, one grant of each and one link', async () => {
    const w = world()
    const { sql } = await issued('6'.repeat(64), 'activate')
    w.sql.raw.exec(sql)
    w.sql.raw.exec(sql)
    expect(rows(w.sql, 'SELECT id FROM users')).toHaveLength(1)
    expect(rows(w.sql, 'SELECT capability FROM capability_grants')).toHaveLength(2)
    expect(rows(w.sql, 'SELECT id FROM invitations')).toHaveLength(1)
    expect(rows(w.sql, "SELECT id FROM audit_events WHERE action LIKE 'account.operator%'")).toHaveLength(1)
    expect(rows(w.sql, 'SELECT id FROM applied_imports')).toHaveLength(1)
  })

  test('--reset gives a link for an account that has a password, and ends its sessions', async () => {
    const w = world()
    const first = await issued('c'.repeat(64), 'activate')
    w.sql.raw.exec(first.sql)
    await w.publicCall(c =>
      c.ConsumeLink({ token: first.token, password: 'a long synthetic passphrase' }),
    )
    expect(Result.isSuccess(await w.signedCall(c => c.GetMe()))).toBe(true)
    const reset = await issued('d'.repeat(64), 'reset', 'a3')
    w.sql.raw.exec(reset.sql)
    const info = await w.publicCall(c => c.InspectLink({ token: reset.token }))
    expect(Result.isSuccess(info) && info.success.purpose).toBe('reset')
    const done = await w.publicCall(c =>
      c.ConsumeLink({ token: reset.token, password: 'a new synthetic passphrase' }),
    )
    expect(Result.isSuccess(done)).toBe(true)
    const signIn = await w.publicCall(c =>
      c.SignIn({ email: EMAIL, password: 'a new synthetic passphrase' }),
    )
    expect(Result.isSuccess(signIn)).toBe(true)
    const old = await w.publicCall(c =>
      c.SignIn({ email: EMAIL, password: 'a long synthetic passphrase' }),
    )
    expect(Result.isFailure(old)).toBe(true)
  })

  test('a reset for an email with no account, or an account with no password, does nothing', async () => {
    const w = world()
    const reset = await issued('e'.repeat(64), 'reset')
    w.sql.raw.exec(reset.sql)
    expect(rows(w.sql, 'SELECT * FROM invitations')).toEqual([])
    expect(rows(w.sql, 'SELECT * FROM audit_events')).toEqual([])
  })

  test('a link expires after 72 hours', async () => {
    const w = world()
    const { token, sql } = await issued('9'.repeat(64), 'activate')
    w.sql.raw.exec(sql)
    w.clock.set(NOW + LINK_TTL_MS + 1)
    const late = await w.publicCall(c => c.InspectLink({ token }))
    expect(Result.isFailure(late) && late.failure).toMatchObject({
      _tag: 'LinkInvalid',
    })
  })

  test('quotes in a name cannot break the statement', async () => {
    const w = world()
    w.sql.raw.exec(
      grantAdminSql({ ...input('1'.repeat(64), 'activate'), name: "O'Neil'; DROP TABLE users; --" }),
    )
    expect(rows(w.sql, 'SELECT name FROM users')).toEqual([
      { name: "O'Neil'; DROP TABLE users; --" },
    ])
  })
})
