import { Effect, Layer, Match, Option, Redacted, Schema } from 'effect'
import { HttpClient, HttpClientRequest } from 'effect/http'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Http } from 'foldkit'

import { CaseDeskRpcs, RPC_PATH, User } from '@case-desk/domain'

const makeClient = RpcClient.make(CaseDeskRpcs)
export type ApiClient = Effect.Success<typeof makeClient>

const ProtocolLayer = RpcClient.layerProtocolHttp({ url: RPC_PATH }).pipe(
  Layer.provide(RpcSerialization.layerJson),
  Layer.provide(Http.layer),
)

export const withApi = <A, E>(
  use: (client: ApiClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(Effect.flatMap(makeClient, use)).pipe(
    Effect.provide(ProtocolLayer),
  )

export const ApiFailure = Schema.Literals(['SignInRequired', 'Unavailable'])
export type ApiFailure = typeof ApiFailure.Type

export const failureOf = (error: unknown): ApiFailure =>
  Match.value(error).pipe(
    Match.when({ _tag: 'Unauthorised' }, (): ApiFailure => 'SignInRequired'),
    Match.orElse((): ApiFailure => 'Unavailable'),
  )

const SessionBody = Schema.Struct({ user: User })
const decodeSessionBody = Schema.decodeUnknownEffect(SessionBody)
const decodeMaybeSessionBody = Schema.decodeUnknownEffect(
  Schema.Struct({ user: Schema.NullOr(User) }),
)

export const SignInRejection = Schema.Literals([
  'InvalidCredentials',
  'Unavailable',
])
export type SignInRejection = typeof SignInRejection.Type

export const fetchSession: Effect.Effect<
  Option.Option<User>,
  ApiFailure
> = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const response = yield* client.get('/api/session')
  const body = yield* decodeMaybeSessionBody(yield* response.json)
  return Option.fromNullishOr(body.user)
}).pipe(
  Effect.mapError((): ApiFailure => 'Unavailable'),
  Effect.provide(Http.layer),
)

export const postSignIn = (
  email: string,
  password: Redacted.Redacted<string>,
): Effect.Effect<User, SignInRejection> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const request = yield* HttpClientRequest.post('/api/login').pipe(
      HttpClientRequest.bodyJson({
        email,
        password: Redacted.value(password),
      }),
    )
    const response = yield* client.execute(request)
    if (response.status === 401 || response.status === 400) {
      return yield* Effect.fail<SignInRejection>('InvalidCredentials')
    }
    const body = yield* decodeSessionBody(yield* response.json)
    return body.user
  }).pipe(
    Effect.catch(error =>
      Effect.fail<SignInRejection>(
        error === 'InvalidCredentials' ? 'InvalidCredentials' : 'Unavailable',
      ),
    ),
    Effect.provide(Http.layer),
  )

export const postSignOut: Effect.Effect<void> = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient
  const request = yield* HttpClientRequest.post('/api/logout').pipe(
    HttpClientRequest.bodyJson({}),
  )
  yield* client.execute(request)
}).pipe(Effect.ignore, Effect.provide(Http.layer))
