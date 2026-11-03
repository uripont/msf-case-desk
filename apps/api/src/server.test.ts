import { Effect, Exit, Layer } from 'effect'
import { FetchHttpClient } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { afterEach, describe, expect, test } from 'vitest'

import {
  CaseDeskRpcs,
  CaseId,
  DEFAULT_RULES,
  RPC_PATH,
  Repository,
  makeMemoryRepository,
} from '@case-desk/domain'
import { SYNTHETIC_ENTRY, SYNTHETIC_USER } from '@case-desk/domain/testing'

import { makeRpcHandler } from './server'
import { SESSION_COOKIE, hashToken } from './session'

const TOKEN = 'b'.repeat(64)

const servers: Array<{ dispose: () => Promise<void> }> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.dispose()))
})

const makeClient = RpcClient.make(CaseDeskRpcs)
type Client = Effect.Success<typeof makeClient>

const signedInRepository = async () => {
  const repository = await Effect.runPromise(makeMemoryRepository())
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* repository.createUser(SYNTHETIC_USER)
      yield* repository.createSession({
        tokenHash: yield* Effect.promise(() => hashToken(TOKEN)),
        userId: SYNTHETIC_USER.id,
        createdAt: 0,
        expiresAt: Number.MAX_SAFE_INTEGER,
      })
    }),
  )
  return Layer.succeed(Repository, repository)
}

const withClient = async <A, E>(
  program: (client: Client) => Effect.Effect<A, E>,
  cookie: string = `${SESSION_COOKIE}=${TOKEN}`,
) => {
  const server = makeRpcHandler(await signedInRepository())
  servers.push(server)
  const fetchThroughServer: typeof fetch = (input, init) => {
    const request = new Request(input, init)
    request.headers.set('cookie', cookie)
    return server.handler(request)
  }
  return Effect.runPromiseExit(
    Effect.scoped(Effect.flatMap(makeClient, program)).pipe(
      Effect.provide(
        RpcClient.layerProtocolHttp({
          url: `https://desk.test${RPC_PATH}`,
        }).pipe(
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, fetchThroughServer),
          ),
        ),
      ),
    ),
  )
}

describe('RPC over HTTP', () => {
  test('a case created through the API is listed and read back', async () => {
    const exit = await withClient(client =>
      Effect.gen(function* () {
        const created = yield* client.CreateCase({ entry: SYNTHETIC_ENTRY })
        const listed = yield* client.ListCases()
        const read = yield* client.GetCase({ id: created.id })
        return { created, listed, read }
      }),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const { created, listed, read } = exit.value
      expect(created.id).toMatch(/^CD-[0-9A-F]{8}$/)
      expect(created).toMatchObject(SYNTHETIC_ENTRY)
      expect(created.enteredByName).toBe(SYNTHETIC_USER.name)
      expect(listed).toEqual([created])
      expect(read).toEqual(created)
    }
  })

  test('updating a case changes the named fields', async () => {
    const exit = await withClient(client =>
      Effect.gen(function* () {
        const created = yield* client.CreateCase({ entry: SYNTHETIC_ENTRY })
        return yield* client.UpdateCase({
          id: created.id,
          patch: { risk: 'High', details: 'Added after a call.' },
        })
      }),
    )
    expect(exit).toEqual(
      Exit.succeed(
        expect.objectContaining({
          risk: 'High',
          urgency: SYNTHETIC_ENTRY.urgency,
          details: 'Added after a call.',
        }),
      ),
    )
  })

  test('a missing case answers CaseNotFound', async () => {
    const exit = await withClient(client =>
      client.GetCase({ id: CaseId.make('CD-MISSING') }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(JSON.stringify(exit)).toContain('CaseNotFound')
  })

  test('rule sets are saved per centre', async () => {
    const exit = await withClient(client =>
      Effect.gen(function* () {
        yield* client.PutRuleSet({
          scope: 'OCB',
          rules: { ...DEFAULT_RULES, version: 'ocb-1', p1MinScore: 6 },
        })
        return yield* client.ListRuleSets()
      }),
    )
    expect(exit).toEqual(
      Exit.succeed([
        expect.objectContaining({
          scope: 'OCB',
          rules: { ...DEFAULT_RULES, version: 'ocb-1', p1MinScore: 6 },
          updatedByName: SYNTHETIC_USER.name,
        }),
      ]),
    )
  })

  test('invalid rules are rejected before they reach storage', async () => {
    const exit = await withClient(client =>
      client.PutRuleSet({
        scope: 'OCB',
        rules: { ...DEFAULT_RULES, p1MinScore: 2, p2MinScore: 4 },
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe('RPC without a session', () => {
  test.each([
    ['no cookie', ''],
    ['an unknown session', `${SESSION_COOKIE}=${'c'.repeat(64)}`],
  ])('every procedure is refused with %s', async (_label, cookie) => {
    const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
      await withClient(client => client.ListCases(), cookie),
      await withClient(client => client.ListRuleSets(), cookie),
      await withClient(
        client => client.CreateCase({ entry: SYNTHETIC_ENTRY }),
        cookie,
      ),
      await withClient(
        client => client.PutRuleSet({ scope: 'OCB', rules: DEFAULT_RULES }),
        cookie,
      ),
    ]
    exits.forEach(exit => {
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain('Unauthorised')
    })
  })
})
