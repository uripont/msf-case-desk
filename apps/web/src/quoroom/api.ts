import { Effect, Layer } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Http } from 'foldkit'

import {
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  QuoroomPublicRpcs,
  QuoroomRpcs,
} from '@case-desk/domain'

// NOTE: The iteration 3 clients. The session cookie is set by the Worker and
// the browser sends it; no token is ever read or written here. A link token
// is only sent in the body of `InspectLink` and `ConsumeLink`, never in a URL.
const makeSigned = RpcClient.make(QuoroomRpcs)
const makePublic = RpcClient.make(QuoroomPublicRpcs)

export type QuoroomClient = Effect.Success<typeof makeSigned>
export type PublicClient = Effect.Success<typeof makePublic>

const protocolAt = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provide(RpcSerialization.layerJson),
    Layer.provide(Http.layer),
  )

export const withQuoroom = <A, E>(
  use: (client: QuoroomClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(Effect.flatMap(makeSigned, use)).pipe(
    Effect.provide(protocolAt(QUOROOM_RPC_PATH)),
  )

export const withPublic = <A, E>(
  use: (client: PublicClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(Effect.flatMap(makePublic, use)).pipe(
    Effect.provide(protocolAt(QUOROOM_PUBLIC_PATH)),
  )
