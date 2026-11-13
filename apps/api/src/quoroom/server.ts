import { Effect, Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'

import {
  QUOROOM_PUBLIC_PATH,
  QUOROOM_RPC_PATH,
  QuoroomPublicRpcs,
  QuoroomRpcs,
  type Repository,
  type ReportRepository,
} from '@case-desk/domain'

import { AuthenticationLive } from '../handlers'
import { authorHandlers } from './author'
import { activityHandlers } from './activity'
import { templateHandlers } from './templates'
import { accountHandlers } from './accounts'
import { authorExtraHandlers } from './authorExtras'
import type { QuoroomClock, QuoroomConfig, QuoroomIds } from './core'
import { makeImageHandler } from './images'
import { publicHandlers } from './public'
import { reviewerHandlers } from './reviewer'

// NOTE: The iteration 3 RPC, served at its own path next to the iteration 2
// one, which keeps working as it was. Stage 3 switches the apps over.

export { QUOROOM_PUBLIC_PATH, QUOROOM_RPC_PATH }

const handlers = QuoroomRpcs.toLayer(
  Effect.succeed(
    QuoroomRpcs.of({
      ...accountHandlers,
      ...templateHandlers,
      ...activityHandlers,
      ...authorHandlers,
      ...authorExtraHandlers,
      ...reviewerHandlers,
    }),
  ),
)

// NOTE: the handlers are typed per module with the requirement left open, so
// the requirement the layer really has is stated here: the repository and the
// injected services (the caller comes from the middleware).
export const QuoroomHandlers = handlers as unknown as Layer.Layer<
  Layer.Success<typeof handlers>,
  Layer.Error<typeof handlers>,
  Repository | ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig
>

export type QuoroomDeps = Layer.Layer<
  ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig
>

export const makeQuoroomRpcHandler = (
  repository: Layer.Layer<Repository>,
  deps: QuoroomDeps,
) =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: QuoroomRpcs,
      path: QUOROOM_RPC_PATH,
      protocol: 'http',
    }).pipe(
      Layer.provide(QuoroomHandlers),
      Layer.provide(AuthenticationLive),
      Layer.provide(Layer.mergeAll(repository, deps)),
      Layer.provide(RpcSerialization.layerJson),
    ),
    { disableLogger: true },
  )

export const makeQuoroomImageHandler = (
  repository: Layer.Layer<Repository>,
  deps: QuoroomDeps,
) => makeImageHandler(Layer.mergeAll(repository, deps))

// NOTE: the public group: no middleware, no session. Sign-in, and the links
// that activate an account or reset a password.
const publicLayer = QuoroomPublicRpcs.toLayer(
  Effect.succeed(QuoroomPublicRpcs.of(publicHandlers)),
) as unknown as Layer.Layer<
  Layer.Success<ReturnType<typeof QuoroomPublicRpcs.toLayer>>,
  never,
  Repository | ReportRepository | QuoroomClock | QuoroomIds | QuoroomConfig
>

export const makeQuoroomPublicHandler = (
  repository: Layer.Layer<Repository>,
  deps: QuoroomDeps,
) =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: QuoroomPublicRpcs,
      path: QUOROOM_PUBLIC_PATH,
      protocol: 'http',
    }).pipe(
      Layer.provide(publicLayer),
      Layer.provide(Layer.mergeAll(repository, deps)),
      Layer.provide(RpcSerialization.layerJson),
    ),
    { disableLogger: true },
  )
