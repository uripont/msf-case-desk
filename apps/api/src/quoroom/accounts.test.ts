import { Effect, Layer, Result } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { afterEach, describe, expect, test } from 'vitest'

import {
  DEFAULT_NOTIFICATION_CONFIG,
  EMAIL_FAILURE_THRESHOLD,
  IP_FAILURE_THRESHOLD,
  QuoroomPublicRpcs,
  QuoroomRpcs,
  ReportRepository,
  Repository,
} from '@case-desk/domain'

import { makeApp } from '../app'
import { makeSqlRepository } from '../d1Repository'
import { hashPassword } from '../password'
import { makeSqlReportRepository } from '../reportRepository'
import { SESSION_COOKIE } from '../session'
import { makeNodeSqlite } from '../testing/nodeSqlite'
import {
  type NetworkPolicy,
  QuoroomConfig,
  QuoroomNetwork,
  SELF_HOSTED_BUCKET,
  clientAddress,
  makeTestClock,
  makeTestIds,
} from './core'
import { QUOROOM_PUBLIC_PATH, QUOROOM_RPC_PATH } from './server'

// NOTE: Accounts, links, sessions and sign-in throttling through the real
// stack: the iteration-2 repository (users and sessions) and the report
// repository share one SQLite database, as they do on D1. Passwords, emails
// and people are invented.

const PASSWORD = 'correct horse battery staple'
const HOUR = 3_600_000

const makePublic = RpcClient.make(QuoroomPublicRpcs)
const makeSigned = RpcClient.make(QuoroomRpcs)

const worlds: Array<{ dispose: () => Promise<void> }> = []
afterEach(async () => {
  await Promise.all(worlds.splice(0).map(world => world.dispose()))
})

const tagOf = (error: unknown): string =>
  (error as { _tag?: string })._tag ?? 'unknown'

const world = async (network: NetworkPolicy = { kind: 'cloudflare' }, ipHeader = 'cf-connecting-ip') => {
  const sql = makeNodeSqlite()
  const users = makeSqlRepository(sql)
  const reports = makeSqlReportRepository(sql)
  const clock = makeTestClock(Date.UTC(2026, 10, 12, 9, 0, 0))
  const app = makeApp(
    Layer.succeed(Repository, users),
    Layer.mergeAll(
      Layer.succeed(ReportRepository, reports),
      clock.layer,
      makeTestIds(),
      Layer.succeed(QuoroomConfig, DEFAULT_NOTIFICATION_CONFIG),
      Layer.succeed(QuoroomNetwork, network),
    ),
  )
  worlds.push({ dispose: () => app.dispose() })
  const run = <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.runPromise(effect as Effect.Effect<A>)
  await run(reports.createUnit({ id: 'unit-1', name: 'Unit One', code: 'U1', createdAt: 1 }))
  const seed = async (id: string, name: string, grant?: { capability: 'admin' | 'author'; unitId?: string }) =>
    run(
      reports.createAccount({
        id,
        email: `${id}@case-desk.test`,
        name,
        passwordHash: await hashPassword(PASSWORD),
        profile: { phone: null, whatsappConsent: false, whatsappConsentAt: null, notifyOnApproval: false, active: true },
        ...(grant === undefined ? {} : { grant }),
        createdBy: null,
        now: 1,
      }),
    )
  await seed('adam', 'Adam Administrator', { capability: 'admin' })
  await seed('alice', 'Alice Author', { capability: 'author', unitId: 'unit-1' })

  // NOTE: a person's browser: its own cookie jar, and an address.
  const browser = (ip = '203.0.113.7') => {
    const jar = new Map<string, string>()
    const fetchFn: typeof fetch = async (input, init) => {
      const request = new Request(input, init)
      request.headers.set(ipHeader, ip)
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
      if (cookie !== '') request.headers.set('cookie', cookie)
      const response = await app.handle(request)
      for (const line of response.headers.getSetCookie()) {
        const [pair = '', ...attributes] = line.split(';').map(part => part.trim())
        const [name = '', value = ''] = pair.split('=')
        const gone = value === '' || attributes.some(attribute => attribute.toLowerCase() === 'max-age=0')
        if (gone) jar.delete(name)
        else jar.set(name, value)
      }
      return response
    }
    const layer = (path: string) =>
      RpcClient.layerProtocolHttp({ url: `https://desk.test${path}` }).pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchFn)),
      )
    const attemptPublic = <A, E>(program: (client: Effect.Success<typeof makePublic>) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.scoped(Effect.flatMap(makePublic, client => Effect.result(program(client)))).pipe(
          Effect.provide(layer(QUOROOM_PUBLIC_PATH)),
        ) as Effect.Effect<Result.Result<A, E>>,
      )
    const attempt = <A, E>(program: (client: Effect.Success<typeof makeSigned>) => Effect.Effect<A, E>) =>
      Effect.runPromise(
        Effect.scoped(Effect.flatMap(makeSigned, client => Effect.result(program(client)))).pipe(
          Effect.provide(layer(QUOROOM_RPC_PATH)),
        ) as Effect.Effect<Result.Result<A, E>>,
      )
    const ok = <A, E>(result: Result.Result<A, E>): A => {
      if (Result.isFailure(result)) throw new Error(`failed: ${JSON.stringify(result.failure)}`)
      return result.success
    }
    return {
      jar,
      attemptPublic,
      attempt,
      signIn: (email: string, password = PASSWORD) =>
        attemptPublic(c => c.SignIn({ email, password })),
      call: async <A, E>(program: (client: Effect.Success<typeof makeSigned>) => Effect.Effect<A, E>) =>
        ok(await attempt(program)),
      callPublic: async <A, E>(program: (client: Effect.Success<typeof makeSigned> extends never ? never : Effect.Success<typeof makePublic>) => Effect.Effect<A, E>) =>
        ok(await attemptPublic(program)),
      session: () => jar.get(SESSION_COOKIE),
    }
  }

  return { sql, reports, clock, run, browser }
}

const failureOf = <A, E>(result: Result.Result<A, E>): E => {
  if (Result.isSuccess(result)) throw new Error(`not refused: ${JSON.stringify(result.success)}`)
  return result.failure
}

describe('sign-in', () => {
  test('signs in with a cookie set by the Worker and a body without the token', async () => {
    const w = await world()
    const alice = w.browser()
    const me = await alice.callPublic(c => c.SignIn({ email: 'alice@case-desk.test', password: PASSWORD }))
    expect(me).toMatchObject({ id: 'alice', name: 'Alice Author' })
    expect(JSON.stringify(me)).not.toContain(alice.session() ?? 'unreachable')
    expect(alice.session()).toMatch(/^[0-9a-f]{64}$/)
    expect((await alice.call(c => c.GetMe())).grants).toEqual([{ capability: 'author', unit: 'unit-1' }])
    // NOTE: and ending it ends that session only.
    const other = w.browser()
    await other.signIn('alice@case-desk.test')
    await alice.call(c => c.SignOut())
    expect(alice.session()).toBeUndefined()
    expect(tagOf(failureOf(await alice.attempt(c => c.GetMe())))).not.toBe('unknown')
    expect((await other.call(c => c.GetMe())).id).toBe('alice')
  })

  test('a wrong password, an unknown email and an account with no password all answer the same', async () => {
    const w = await world()
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')
    const invited = await adam.call(c =>
      c.GrantCapability({ email: 'nopass@case-desk.test', name: 'No Password', capability: 'template_editor' }),
    )
    expect(invited.link?.purpose).toBe('activate')
    const guest = w.browser()
    const answers = [
      await guest.signIn('alice@case-desk.test', 'wrong password entirely'),
      await guest.signIn('nobody@case-desk.test'),
      await guest.signIn('nopass@case-desk.test', 'anything at all'),
    ].map(failureOf)
    expect(answers.map(tagOf)).toEqual(['InvalidCredentials', 'InvalidCredentials', 'InvalidCredentials'])
    expect(JSON.stringify(answers[0])).toBe(JSON.stringify(answers[1]))
    expect(JSON.stringify(answers[1])).toBe(JSON.stringify(answers[2]))
    expect(guest.session()).toBeUndefined()
  })

  test('failures per email are throttled, the wait doubles, refused attempts are not counted and a success clears it', async () => {
    const w = await world()
    const guest = w.browser()
    for (let i = 0; i < EMAIL_FAILURE_THRESHOLD; i += 1) {
      expect(tagOf(failureOf(await guest.signIn('alice@case-desk.test', 'wrong password entirely')))).toBe('InvalidCredentials')
    }
    // NOTE: the next attempt, even with the right password, waits a minute.
    const first = failureOf(await guest.signIn('alice@case-desk.test'))
    expect(first).toMatchObject({ _tag: 'Throttled', retryAfterSeconds: 60 })
    // NOTE: asking again does not make it longer.
    w.clock.advance(10_000)
    expect(failureOf(await guest.signIn('alice@case-desk.test'))).toMatchObject({ _tag: 'Throttled', retryAfterSeconds: 50 })
    // NOTE: another email from the same address is not held up by it.
    expect(tagOf(failureOf(await guest.signIn('adam@case-desk.test', 'wrong password entirely')))).toBe('InvalidCredentials')

    // NOTE: after the wait one more failure is allowed, and doubles the wait.
    w.clock.advance(51_000)
    expect(tagOf(failureOf(await guest.signIn('alice@case-desk.test', 'wrong password entirely')))).toBe('InvalidCredentials')
    expect(failureOf(await guest.signIn('alice@case-desk.test'))).toMatchObject({ _tag: 'Throttled', retryAfterSeconds: 120 })
    w.clock.advance(121_000)
    expect(tagOf(failureOf(await guest.signIn('alice@case-desk.test', 'wrong password entirely')))).toBe('InvalidCredentials')
    expect(failureOf(await guest.signIn('alice@case-desk.test'))).toMatchObject({ _tag: 'Throttled', retryAfterSeconds: 240 })

    // NOTE: the right password signs in once the wait is over.
    w.clock.advance(241_000)
    await guest.callPublic(c => c.SignIn({ email: 'alice@case-desk.test', password: PASSWORD }))
    expect(guest.session()).toBeDefined()
    // NOTE: a success clears the failures of that email: a full allowance
    // again, then the first wait is a minute, not the doubled one.
    w.clock.advance(1_000)
    for (let i = 0; i < EMAIL_FAILURE_THRESHOLD; i += 1) {
      expect(tagOf(failureOf(await guest.signIn('alice@case-desk.test', 'wrong password entirely')))).toBe('InvalidCredentials')
    }
    expect(failureOf(await guest.signIn('alice@case-desk.test'))).toMatchObject({ _tag: 'Throttled', retryAfterSeconds: 60 })
  })

  test('failures per address are throttled across emails', async () => {
    const w = await world()
    const guest = w.browser('198.51.100.9')
    for (let i = 0; i < IP_FAILURE_THRESHOLD; i += 1) {
      expect(tagOf(failureOf(await guest.signIn(`person${i}@case-desk.test`, 'wrong password entirely')))).toBe('InvalidCredentials')
    }
    expect(failureOf(await guest.signIn('adam@case-desk.test'))).toMatchObject({ _tag: 'Throttled', retryAfterSeconds: 60 })
    // NOTE: somebody else, from another address, is not affected.
    expect((await w.browser('198.51.100.10').callPublic(c => c.SignIn({ email: 'adam@case-desk.test', password: PASSWORD }))).id).toBe('adam')
  })
})

describe('the address of a caller by runtime (D20)', () => {
  test('clientAddress reads cf-connecting-ip only on Cloudflare', () => {
    const headers = { 'cf-connecting-ip': ' 198.51.100.1 ', 'x-real-ip': '192.0.2.5, 10.0.0.1' }
    expect(clientAddress({ kind: 'cloudflare' }, headers)).toBe('198.51.100.1')
    expect(clientAddress({ kind: 'cloudflare' }, {})).toBe('unknown')
    expect(clientAddress({ kind: 'self_hosted' }, headers)).toBe(SELF_HOSTED_BUCKET)
    expect(clientAddress({ kind: 'header', name: 'X-Real-IP' }, headers)).toBe('192.0.2.5')
    expect(clientAddress({ kind: 'header', name: 'x-real-ip' }, {})).toBe(SELF_HOSTED_BUCKET)
    expect(clientAddress({ kind: 'header', name: 'x-real-ip' }, { 'x-real-ip': 'x'.repeat(500) })).toHaveLength(64)
  })

  test('self-hosted ignores a forged cf-connecting-ip: one bucket, so rotating it does not escape the limit', async () => {
    const w = await world({ kind: 'self_hosted' })
    for (let i = 0; i < IP_FAILURE_THRESHOLD; i += 1) {
      const forger = w.browser(`198.51.100.${i}`)
      expect(tagOf(failureOf(await forger.signIn(`person${i}@case-desk.test`, 'wrong password entirely')))).toBe('InvalidCredentials')
    }
    expect(failureOf(await w.browser('198.51.100.200').signIn('adam@case-desk.test'))).toMatchObject({ _tag: 'Throttled' })
  })

  test('a trusted proxy header is honoured, and a different header is not', async () => {
    const w = await world({ kind: 'header', name: 'x-real-ip' }, 'x-real-ip')
    const guest = w.browser('198.51.100.9')
    for (let i = 0; i < IP_FAILURE_THRESHOLD; i += 1) {
      expect(tagOf(failureOf(await guest.signIn(`person${i}@case-desk.test`, 'wrong password entirely')))).toBe('InvalidCredentials')
    }
    expect(failureOf(await guest.signIn('adam@case-desk.test'))).toMatchObject({ _tag: 'Throttled' })
    expect((await w.browser('198.51.100.10').callPublic(c => c.SignIn({ email: 'adam@case-desk.test', password: PASSWORD }))).id).toBe('adam')
  })

  test('old attempts are pruned, a bounded number per sign-in', async () => {
    const w = await world()
    const guest = w.browser()
    for (let i = 0; i < 3; i += 1) await guest.signIn(`p${i}@case-desk.test`, 'wrong password entirely')
    const count = () => (w.sql.raw.prepare('SELECT COUNT(*) AS n FROM sign_in_attempts').get() as { n: number }).n
    expect(count()).toBe(3)
    w.clock.advance(60 * 60_000)
    await guest.signIn('alice@case-desk.test')
    expect(count()).toBe(1)
  })
})

describe('the reviewer registry holds the unit\'s own entries (D13)', () => {
  test('an author never changes, reads or reveals another account through the registry', async () => {
    const w = await world()
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')
    await adam.call(c =>
      c.SetNotificationPreferences({ notifyOnApproval: false, phone: '+34600000001', whatsappConsent: true }),
    )
    const alice = w.browser()
    await alice.signIn('alice@case-desk.test')
    const before = await adam.call(c => c.GetMe())

    const added = await alice.call(c =>
      c.AddReviewer({ unit: 'unit-1', name: 'Typed By Alice', email: 'adam@case-desk.test', phone: '+34999999999', whatsappConsent: true }),
    )
    const fresh = await alice.call(c =>
      c.AddReviewer({ unit: 'unit-1', name: 'New Reviewer', email: 'rev@case-desk.test', phone: '+34988888888', whatsappConsent: false }),
    )
    // NOTE: the same shape for an existing and a new account, and the link
    // only for the new one; nothing of the stored account in the answer.
    expect(Object.keys(added).filter(key => key !== 'link').sort()).toEqual(
      Object.keys(fresh).filter(key => key !== 'link').sort(),
    )
    expect(added.link).toBeUndefined()
    expect(fresh.link).toBeDefined()
    expect(JSON.stringify(added)).not.toContain('Adam Administrator')
    expect(JSON.stringify(added)).not.toContain('+34600000001')

    const updated = await alice.call(c =>
      c.UpdateReviewer({ unit: 'unit-1', accountId: added.accountId, name: 'Renamed By Alice', phone: '+34111111111', whatsappConsent: true }),
    )
    expect(updated).toMatchObject({ name: 'Renamed By Alice', phone: '+34111111111', consentRequested: true })

    // NOTE: the account itself is untouched: name, phone and consent.
    expect(await adam.call(c => c.GetMe())).toEqual(before)

    const listed = await alice.call(c => c.ListReviewers({ unit: 'unit-1' }))
    expect(listed.find(entry => entry.accountId === added.accountId)).toMatchObject({ name: 'Renamed By Alice' })
    expect(JSON.stringify(listed)).not.toContain('passwordSetAt')
    expect(JSON.stringify(listed)).not.toContain('whatsappConsentAt')
    expect(JSON.stringify(listed)).not.toContain('Adam Administrator')

    // NOTE: consent is given by the reviewer, on their own account.
    const mine = await adam.call(c => c.SetNotificationPreferences({ notifyOnApproval: false, whatsappConsent: false }))
    expect(mine.whatsappConsent).toBe(false)
  })
})

describe('links', () => {
  test('an invited existing email gets no link and the same response shape; a new one is activated once', async () => {
    const w = await world()
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')

    // NOTE: an author of the unit invites reviewers, not an administrator.
    const alice = w.browser()
    await alice.signIn('alice@case-desk.test')
    expect(tagOf(failureOf(await adam.attempt(c => c.InviteToUnit({ unit: 'unit-1', email: 'z@case-desk.test', name: 'Z Person' }))))).toBe('NotPermitted')
    const fresh = await alice.call(c => c.InviteToUnit({ unit: 'unit-1', email: 'newcomer@case-desk.test', name: 'New Comer' }))
    const existing = await alice.call(c => c.InviteToUnit({ unit: 'unit-1', email: 'alice@case-desk.test', name: 'Whoever Typed' }))
    expect(fresh.link?.purpose).toBe('activate')
    expect(existing.link).toBeUndefined()
    expect(Object.keys(fresh.account).sort()).toEqual(Object.keys(existing.account).sort())
    // NOTE: the name is what the caller typed, never what is stored.
    expect(existing.account.name).toBe('Whoever Typed')
    expect(JSON.stringify(existing)).not.toContain('Alice Author')

    const granted = await adam.call(c => c.GrantCapability({ email: 'alice@case-desk.test', capability: 'template_editor' }))
    expect(granted.link).toBeUndefined()
    expect(granted.account.name).toBe('Alice Author')

    const token = fresh.link?.token ?? ''
    // NOTE: only the hash of the token is stored.
    const stored = w.sql.raw.prepare('SELECT * FROM invitations').all()
    expect(JSON.stringify(stored)).not.toContain(token)

    const newcomer = w.browser()
    const info = await newcomer.callPublic(c => c.InspectLink({ token }))
    expect(info).toMatchObject({ purpose: 'activate', name: 'New Comer', email: 'newcomer@case-desk.test' })
    const me = await newcomer.callPublic(c => c.ConsumeLink({ token, password: 'a brand new passphrase' }))
    expect(me.email).toBe('newcomer@case-desk.test')
    expect(newcomer.session()).toBeDefined()
    expect((await newcomer.call(c => c.GetMe())).id).toBe(me.id)

    // NOTE: accepted once: used, unknown and malformed all answer the same.
    const guest = w.browser()
    const answers = [
      failureOf(await guest.attemptPublic(c => c.ConsumeLink({ token, password: 'another passphrase here' }))),
      failureOf(await guest.attemptPublic(c => c.InspectLink({ token }))),
      failureOf(await guest.attemptPublic(c => c.InspectLink({ token: 'f'.repeat(64) }))),
    ]
    expect(answers.map(tagOf)).toEqual(['LinkInvalid', 'LinkInvalid', 'LinkInvalid'])
    expect(guest.session()).toBeUndefined()
    // NOTE: the password that was set works, with a new browser.
    expect((await w.browser().callPublic(c => c.SignIn({ email: 'newcomer@case-desk.test', password: 'a brand new passphrase' }))).id).toBe(me.id)
  })

  test('using one link of an account invalidates its other unused links', async () => {
    const w = await world()
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')
    const first = await adam.call(c => c.IssueReset({ accountId: 'alice' }))
    const second = await adam.call(c => c.IssueReset({ accountId: 'alice' }))
    await w.browser().callPublic(c => c.ConsumeLink({ token: first.token, password: 'a brand new passphrase' }))
    const guest = w.browser()
    expect(tagOf(failureOf(await guest.attemptPublic(c => c.InspectLink({ token: second.token }))))).toBe('LinkInvalid')
    expect(tagOf(failureOf(await guest.attemptPublic(c => c.ConsumeLink({ token: second.token, password: 'another passphrase here' }))))).toBe('LinkInvalid')
  })

  test('a link expires after 72 hours', async () => {
    const w = await world()
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')
    const invited = await adam.call(c => c.GrantCapability({ email: 'late@case-desk.test', name: 'Late Comer', capability: 'template_editor' }))
    const token = invited.link?.token ?? ''
    w.clock.advance(72 * HOUR + 1000)
    expect(tagOf(failureOf(await w.browser().attemptPublic(c => c.ConsumeLink({ token, password: 'a brand new passphrase' }))))).toBe('LinkInvalid')
    // NOTE: just inside the time it works.
    const early = await adam.call(c => c.GrantCapability({ email: 'early@case-desk.test', name: 'Early Bird', capability: 'template_editor' }))
    w.clock.advance(72 * HOUR - 1000)
    expect((await w.browser().callPublic(c => c.ConsumeLink({ token: early.link?.token ?? '', password: 'a brand new passphrase' }))).name).toBe('Early Bird')
  })

  test('a reset ends every session of the account and signs in the one who used it', async () => {
    const w = await world()
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')
    const phone = w.browser()
    const laptop = w.browser()
    await phone.signIn('alice@case-desk.test')
    await laptop.signIn('alice@case-desk.test')
    expect((await phone.call(c => c.GetMe())).id).toBe('alice')

    // NOTE: only an administrator issues one.
    expect(tagOf(failureOf(await phone.attempt(c => c.IssueReset({ accountId: 'alice' }))))).toBe('NotPermitted')
    const reset = await adam.call(c => c.IssueReset({ accountId: 'alice' }))
    expect(reset.purpose).toBe('reset')
    const fresh = w.browser()
    await fresh.callPublic(c => c.ConsumeLink({ token: reset.token, password: 'a replaced passphrase' }))
    expect((await fresh.call(c => c.GetMe())).id).toBe('alice')
    // NOTE: the two older sessions are gone, the old password too.
    expect(Result.isFailure(await phone.attempt(c => c.GetMe()))).toBe(true)
    expect(Result.isFailure(await laptop.attempt(c => c.GetMe()))).toBe(true)
    expect(tagOf(failureOf(await w.browser().signIn('alice@case-desk.test')))).toBe('InvalidCredentials')
    expect((await w.browser().callPublic(c => c.SignIn({ email: 'alice@case-desk.test', password: 'a replaced passphrase' }))).id).toBe('alice')
    // NOTE: the reset is in the log.
    const audit = w.sql.raw.prepare("SELECT action FROM audit_events ORDER BY id").all() as Array<{ action: string }>
    expect(audit.map(row => row.action)).toEqual(expect.arrayContaining(['account.reset_issued', 'account.password_reset']))
  })

  test('grants need an administrator, and the unit rules hold', async () => {
    const w = await world()
    const alice = w.browser()
    await alice.signIn('alice@case-desk.test')
    expect(tagOf(failureOf(await alice.attempt(c => c.GrantCapability({ email: 'x@case-desk.test', name: 'X Person', capability: 'admin' }))))).toBe('NotPermitted')
    expect(tagOf(failureOf(await alice.attempt(c => c.ListAccounts())))).toBe('NotPermitted')
    expect((await alice.call(c => c.ListUnits())).map(unit => unit.id)).toContain('unit-1')
    const adam = w.browser()
    await adam.signIn('adam@case-desk.test')
    expect(tagOf(failureOf(await adam.attempt(c => c.GrantCapability({ email: 'y@case-desk.test', name: 'Y Person', capability: 'author' }))))).toBe('Validation')
    const accounts = await adam.call(c => c.ListAccounts())
    expect(accounts.map(account => account.id).sort()).toEqual(['adam', 'alice'])
    // NOTE: the last administrator cannot be revoked.
    expect(Result.isFailure(await adam.attempt(c => c.RevokeCapability({ accountId: 'adam', capability: 'admin' })))).toBe(true)
  })
})
