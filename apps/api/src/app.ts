import { Effect, Layer, Option, Schema } from 'effect'

import { DEFAULT_RULES, RPC_PATH, type Repository } from '@case-desk/domain'

import { withReferrerPolicy } from './headers'
import { withSink } from './quoroom/cookies'
import {
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  type QuoroomDeps,
  makeQuoroomImageHandler,
  makeQuoroomPublicHandler,
  makeQuoroomRpcHandler,
} from './quoroom/server'
import { makeRpcHandler } from './server'
import {
  Credentials,
  clearedSessionCookie,
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
  quoroom?: QuoroomDeps,
) => {
  const rpc = makeRpcHandler(repository)
  const quoroomRpc =
    quoroom === undefined ? undefined : makeQuoroomRpcHandler(repository, quoroom)
  const quoroomPublic =
    quoroom === undefined
      ? undefined
      : makeQuoroomPublicHandler(repository, quoroom)
  const images =
    quoroom === undefined
      ? undefined
      : makeQuoroomImageHandler(repository, quoroom)
  const run = <A>(program: Effect.Effect<A, unknown, Repository>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(repository),
        Effect.catch(() =>
          Effect.succeed(json({ error: 'StorageUnavailable' }, 503)),
        ),
      ),
    )

  const login = async (request: Request): Promise<Response> => {
    if (!isJsonPost(request)) {
      return json({ error: 'BadRequest' }, 400)
    }
    return Option.match(decodeCredentials(await readJson(request)), {
      onNone: () => Promise.resolve(json({ error: 'BadRequest' }, 400)),
      onSome: credentials =>
        run(
          Effect.map(signIn(credentials), maybeSignIn =>
            Option.match(maybeSignIn, {
              onNone: () => json({ error: 'InvalidCredentials' }, 401),
              onSome: ({ user, token, expiresAt }) =>
                json({ user }, 200, {
                  'set-cookie': sessionCookie(token, expiresAt),
                }),
            }),
          ),
        ),
    })
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
    if (pathname === '/api/login') {
      return login(request)
    }
    if (pathname === '/api/logout') {
      return logout(request)
    }
    if (pathname === '/api/session') {
      return session(request)
    }
    if (pathname === RPC_PATH) {
      return rpc.handler(request)
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
      return served(quoroomRpc.handler, QUOROOM_RPC_PATH)
    }
    if (
      quoroomPublic !== undefined &&
      (pathname === QUOROOM_PUBLIC_PATH || pathname === `${QUOROOM_PUBLIC_PATH}/`)
    ) {
      return served(quoroomPublic.handler, QUOROOM_PUBLIC_PATH)
    }
    if (
      images !== undefined &&
      (pathname === '/api/images' || pathname.startsWith('/api/images/'))
    ) {
      return images(request)
    }
    if (pathname === `${RPC_PATH}/`) {
      const url = new URL(request.url)
      url.pathname = RPC_PATH
      return rpc.handler(new Request(url, request))
    }
    return Promise.resolve(json({ error: 'NotFound' }, 404))
  }

  const handle = (request: Request): Promise<Response> =>
    route(request).then(withReferrerPolicy)

  return {
    handle,
    dispose: async () => {
      await Promise.all([
        rpc.dispose(),
        quoroomRpc?.dispose(),
        quoroomPublic?.dispose(),
      ])
    },
  }
}
