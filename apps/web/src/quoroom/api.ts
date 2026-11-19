import { Effect, Layer, Schema } from 'effect'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { Dom, Http } from 'foldkit'

import {
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  QuoroomPublicRpcs,
  QuoroomRpcs,
} from '@quoroom/domain'

// NOTE: The API clients. The session cookie is set by the Worker and
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

// NOTE: A signed-in call that the server answers with `Unauthorised` means the
// session has ended (a reset, a sign-out elsewhere, 14 days). The screen that
// made the call still gets its failure; the app is told on the window, so it
// can ask for the password again without losing what the screens hold.
export const SESSION_ENDED_EVENT = 'quoroom-session-ended'

export const sessionEvents: Dom.TypedEventTarget<{
  [SESSION_ENDED_EVENT]: Event
}> = window

const isUnauthorised = Schema.is(
  Schema.Struct({ _tag: Schema.Literal('Unauthorised') }),
)

const announceSessionEnded = (error: unknown): Effect.Effect<void> =>
  isUnauthorised(error)
    ? Effect.sync(() => {
        window.dispatchEvent(new Event(SESSION_ENDED_EVENT))
      })
    : Effect.void

export const withQuoroom = <A, E>(
  use: (client: QuoroomClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(Effect.flatMap(makeSigned, use)).pipe(
    Effect.tapError(announceSessionEnded),
    Effect.provide(protocolAt(QUOROOM_RPC_PATH)),
  )

export const withPublic = <A, E>(
  use: (client: PublicClient) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.scoped(Effect.flatMap(makePublic, use)).pipe(
    Effect.provide(protocolAt(QUOROOM_PUBLIC_PATH)),
  )
