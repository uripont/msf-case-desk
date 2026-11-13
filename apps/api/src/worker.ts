import { Layer } from 'effect'

import { runtimeModeOf } from '@case-desk/domain'

import { makeApp } from './app'
import { withReferrerPolicy } from './headers'
import { layerSql } from './d1Repository'
import { QuoroomServicesLive } from './quoroom/core'
import { layerSqlReport } from './reportRepository'
import { fromD1 } from './sql'

export type Env = {
  readonly ASSETS: Fetcher
  readonly DB: D1Database
  // NOTE: `demo` or `pilot` (D20), set by the stack. Unset means `demo`.
  readonly RUNTIME_MODE?: string
}

const API_PREFIX = '/api/'

// NOTE: the API is built for each request and disposed after it. Workers do
// not let one request's I/O run inside fibers started by another request,
// so the RPC server cannot be shared across requests.
const handleApi = async (
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> => {
  const app = makeApp(
    layerSql(env.DB),
    Layer.mergeAll(layerSqlReport(fromD1(env.DB)), QuoroomServicesLive),
    runtimeModeOf(env.RUNTIME_MODE),
  )
  try {
    return await app.handle(request)
  } finally {
    context.waitUntil(app.dispose())
  }
}

export default {
  fetch: (request, env, context) =>
    new URL(request.url).pathname.startsWith(API_PREFIX)
      ? handleApi(request, env, context)
      : env.ASSETS.fetch(request).then(withReferrerPolicy),
} satisfies ExportedHandler<Env>
