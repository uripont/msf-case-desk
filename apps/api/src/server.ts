import { Layer } from 'effect'
import { HttpRouter } from 'effect/http'
import { RpcSerialization, RpcServer } from 'effect/rpc'

import { CaseDeskRpcs, RPC_PATH, type Repository } from '@case-desk/domain'

import { CaseDeskHandlers } from './handlers'

export const makeRpcHandler = (repository: Layer.Layer<Repository>) =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({
      group: CaseDeskRpcs,
      path: RPC_PATH,
      protocol: 'http',
    }).pipe(
      Layer.provide(CaseDeskHandlers),
      Layer.provide(repository),
      Layer.provide(RpcSerialization.layerJson),
    ),
    { disableLogger: true },
  )
