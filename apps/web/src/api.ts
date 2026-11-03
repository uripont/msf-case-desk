import { Effect, Layer, Match, Schema } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Http } from 'foldkit'

import { CaseDeskRpcs, RPC_PATH } from '@case-desk/domain'

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
