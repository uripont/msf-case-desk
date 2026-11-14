import { Effect, Layer, Option, Schema } from 'effect'

import {
  CONFIG_PATH,
  DEFAULT_RULES,
  RPC_PATH,
  Repository,
  type RuntimeMode,
} from '@case-desk/domain'

import { withReferrerPolicy } from './headers'
import { makeConfigHandler } from './quoroom/config'
import { withSink } from './quoroom/cookies'
import {
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  type QuoroomDeps,
  makeQuoroomImageHandler,
  makeQuoroomPublicHandler,
  makeQuoroomRpcHandler,
} from './quoroom/server'
import { authenticate } from './quoroom/signin'
import { makeRpcHandler } from './server'
import {
  Credentials,
  SESSION_MS,
  clearedSessionCookie,
  hashToken,
  newToken,
  sessionCookie,
  sessionUser,
  signIn,
  signOut,
  tokenFromCookies,
} from './session'

const json = (body: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', ...headers },
  })

const decodeCredentials = Schema.decodeUnknownOption(Credentials)

const readJson = (request: Request): Promise<unknown> =>
  request.json().catch(() => undefined)

// NOTE: requiring a JSON body makes a cross-site form unable to post here,
// on top of the SameSite cookie.
const isJsonPost = (request: Request): boolean =>
  request.method === 'POST' &&
  (request.headers.get('content-type') ?? '').startsWith('application/json')

// NOTE: `quoroom` carries the iteration 3 repository, clock and ID services.
// With it the app also serves the iteration 3 RPC at `/api/q/rpc` and the
// image route at `/api/images`; without it the app is exactly iteration 2.
export const makeApp = (
  repository: Layer.Layer<Repository>,
  quoroom: QuoroomDeps | undefined,
  mode: RuntimeMode,
) => {
  // NOTE: each handler is built on first use, so a request builds only the one
  // RPC server it is routed to (building one is most of the fixed CPU cost of
  // a request; the Worker builds a new app per request).
  const once = <A>(make: () => A): (() => A) => {
    let built: { value: A } | undefined
    return () => {
      built ??= { value: make() }
      return built.value
    }
  }
  const built: Array<{ dispose: () => Promise<void> }> = []
  const tracked = <A extends { dispose: () => Promise<void> }>(
    make: () => A,
  ): (() => A) =>
    once(() => {
      const handler = make()
      built.push(handler)
      return handler
    })
  const config =
    quoroom === undefined ? undefined : once(() => makeConfigHandler(quoroom, mode))
  const rpc = tracked(() => makeRpcHandler(repository))
  const quoroomRpc =
    quoroom === undefined
      ? undefined
      : tracked(() => makeQuoroomRpcHandler(repository, quoroom))
  const quoroomPublic =
    quoroom === undefined
      ? undefined
      : tracked(() => makeQuoroomPublicHandler(repository, quoroom))
  const images =
    quoroom === undefined
      ? undefined
      : once(() => makeQuoroomImageHandler(repository, quoroom))
  const run = <A>(program: Effect.Effect<A, unknown, Repository>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(repository),
        Effect.catch(() =>
          Effect.succeed(json({ error: 'StorageUnavailable' }, 503)),
        ),
      ),
    )

  // NOTE: the demo's legacy sign-in. With the Quoroom services it goes
  // through the same throttle and `active` check as the Quoroom `SignIn`
  // (`authenticate`), so neither is an unthrottled oracle for the other.
  // Without them (the frozen iteration 2 setup) it is the old sign-in.
  const quoroomLogin = (
    credentials: Credentials,
    request: Request,
    deps: QuoroomDeps,
  ): Promise<Response> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* Repository
        const headers = Object.fromEntries(request.headers.entries())
        const { account, now } = yield* authenticate(
          credentials.email,
          credentials.password,
          headers,
        )
        const token = newToken()
        const expiresAt = now + SESSION_MS
        yield* repo.createSession({
          tokenHash: yield* Effect.promise(() => hashToken(token)),
          userId: account.id as never,
          createdAt: now,
          expiresAt,
        })
        return json(
          { user: { id: account.id, email: account.email, name: account.name } },
          200,
          { 'set-cookie': sessionCookie(token, expiresAt) },
        )
      }).pipe(
        Effect.catch((error: unknown) => {
          const tag = (error as { _tag?: string })._tag
          if (tag === 'Throttled') {
            const wait = (error as { retryAfterSeconds: number }).retryAfterSeconds
            return Effect.succeed(
              json({ error: 'Throttled', retryAfterSeconds: wait }, 429, {
                'retry-after': String(wait),
              }),
            )
          }
          if (tag === 'InvalidCredentials') {
            return Effect.succeed(json({ error: 'InvalidCredentials' }, 401))
          }
          return Effect.succeed(json({ error: 'StorageUnavailable' }, 503))
        }),
        Effect.provide(Layer.mergeAll(repository, deps)),
      ) as Effect.Effect<Response>,
    )

  const login = async (request: Request): Promise<Response> => {
    if (!isJsonPost(request)) {
      return json({ error: 'BadRequest' }, 400)
    }
    const decoded = decodeCredentials(await readJson(request))
    if (Option.isNone(decoded)) {
      return json({ error: 'BadRequest' }, 400)
    }
    if (quoroom !== undefined) {
      return quoroomLogin(decoded.value, request, quoroom)
    }
    return run(
      Effect.map(signIn(decoded.value), maybeSignIn =>
        Option.match(maybeSignIn, {
          onNone: () => json({ error: 'InvalidCredentials' }, 401),
          onSome: ({ user, token, expiresAt }) =>
            json({ user }, 200, {
              'set-cookie': sessionCookie(token, expiresAt),
            }),
        }),
      ),
    )
  }

  const logout = (request: Request): Promise<Response> => {
    if (!isJsonPost(request)) {
      return Promise.resolve(json({ error: 'BadRequest' }, 400))
    }
    const cleared = json({ user: null }, 200, {
      'set-cookie': clearedSessionCookie(),
    })
    return Option.match(tokenFromCookies(request.headers.get('cookie')), {
      onNone: () => Promise.resolve(cleared),
      onSome: token => run(Effect.as(signOut(token), cleared)),
    })
  }

  // NOTE: being signed out is a normal answer here, not an error, so the
  // browser does not log a failed request on every visit.
  const session = (request: Request): Promise<Response> =>
    Option.match(tokenFromCookies(request.headers.get('cookie')), {
      onNone: () => Promise.resolve(json({ user: null })),
      onSome: token =>
        run(
          Effect.map(sessionUser(token), maybeUser =>
            Option.match(maybeUser, {
              onNone: () => json({ user: null }),
              onSome: user => json({ user }),
            }),
          ),
        ),
    })

  const route = (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (pathname === '/api/health') {
      return Promise.resolve(
        json({ status: 'ok', rulesVersion: DEFAULT_RULES.version }),
      )
    }
    // NOTE: the legacy routes belong to the triage demo; a pilot has none
    // of them (D20).
    if (pathname === '/api/login' || pathname === '/api/logout' || pathname === '/api/session') {
      if (mode === 'pilot') {
        return Promise.resolve(json({ error: 'NotFound' }, 404))
      }
      return pathname === '/api/login'
        ? login(request)
        : pathname === '/api/logout'
          ? logout(request)
          : session(request)
    }
    if (config !== undefined && pathname === CONFIG_PATH) {
      return config()(request)
    }
    // NOTE: the triage desk is switched off in a pilot (D20).
    if (mode === 'pilot' && (pathname === RPC_PATH || pathname === `${RPC_PATH}/`)) {
      return Promise.resolve(json({ error: 'NotFound' }, 404))
    }
    if (pathname === RPC_PATH) {
      return rpc().handler(request)
    }
    // NOTE: the session cookie of the iteration 3 RPC (sign-in, links,
    // sign-out) is set by the handlers through a per-request slot, and the
    // pages that carry a link token send no referrer.
    const served = (
      handler: (request: Request) => Promise<Response>,
      path: string,
    ): Promise<Response> => {
      let target = request
      if (pathname !== path) {
        const url = new URL(request.url)
        url.pathname = path
        target = new Request(url, request)
      }
      return withSink(target, handler).then(response => {
        const headers = new Headers(response.headers)
        headers.set('referrer-policy', 'no-referrer')
        headers.set('cache-control', 'no-store')
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        })
      })
    }
    if (
      quoroomRpc !== undefined &&
      (pathname === QUOROOM_RPC_PATH || pathname === `${QUOROOM_RPC_PATH}/`)
    ) {
      return served(quoroomRpc().handler, QUOROOM_RPC_PATH)
    }
    if (
      quoroomPublic !== undefined &&
      (pathname === QUOROOM_PUBLIC_PATH || pathname === `${QUOROOM_PUBLIC_PATH}/`)
    ) {
      return served(quoroomPublic().handler, QUOROOM_PUBLIC_PATH)
    }
    if (
      images !== undefined &&
      (pathname === '/api/images' || pathname.startsWith('/api/images/'))
    ) {
      return images()(request)
    }
    if (pathname === `${RPC_PATH}/`) {
      const url = new URL(request.url)
      url.pathname = RPC_PATH
      return rpc().handler(new Request(url, request))
    }
    return Promise.resolve(json({ error: 'NotFound' }, 404))
  }

  const handle = (request: Request): Promise<Response> =>
    route(request).then(withReferrerPolicy)

  return {
    handle,
    dispose: async () => {
      await Promise.all(built.map(handler => handler.dispose()))
    },
  }
}
