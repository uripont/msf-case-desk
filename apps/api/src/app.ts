import { Effect, Layer, Option, Schema } from 'effect'

import { DEFAULT_RULES, RPC_PATH, type Repository } from '@case-desk/domain'

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

export const makeApp = (repository: Layer.Layer<Repository>) => {
  const rpc = makeRpcHandler(repository)
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

  const handle = (request: Request): Promise<Response> => {
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
    if (pathname === `${RPC_PATH}/`) {
      const url = new URL(request.url)
      url.pathname = RPC_PATH
      return rpc.handler(new Request(url, request))
    }
    return Promise.resolve(json({ error: 'NotFound' }, 404))
  }

  return { handle, dispose: rpc.dispose }
}
