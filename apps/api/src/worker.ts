import { Layer } from 'effect'

import { makeApp } from './app'
import { withReferrerPolicy } from './headers'
import { modeOf } from './runtimeMode'
import { layerSql } from './d1Repository'
import { QuoroomServicesLive } from './quoroom/core'
import { layerSqlReport } from './reportRepository'
import { fromD1 } from './sql'
import {
  TICK_PATH,
  type TickEnv,
  handleTick,
  notificationConfigFrom,
  scheduledPass,
} from './tick'

export type Env = TickEnv & {
  readonly ASSETS: Fetcher
  readonly DB: D1Database
  // NOTE: `demo` or `pilot` (D20), set by the stack. Unset means `pilot`; any
  // other value is a configuration error (see `modeOf`).
  readonly RUNTIME_MODE?: string
  // NOTE: the `NOTIFY_*_MINUTES` timings (D12) and `TICK_SECRET` are in `TickEnv`.
  // Both the handlers that write the jobs and the pass that sends them read the
  // timings, so a test environment's minutes apply to both.
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
  const mode = modeOf(env.RUNTIME_MODE)
  if (mode.refusal !== undefined) {
    return withReferrerPolicy(mode.refusal)
  }
  const app = makeApp(
    layerSql(env.DB),
    Layer.mergeAll(layerSqlReport(fromD1(env.DB)), QuoroomServicesLive(notificationConfigFrom(env))),
    mode.mode,
  )
  try {
    return await app.handle(request)
  } finally {
    context.waitUntil(app.dispose())
  }
}

export default {
  // NOTE: The notification pass (stage 7). Only the Workers that have a Cron
  // Trigger run it (the pilot, test environments and the demo's `app`), so no
  // message is sent twice. It builds its own layer from `env.DB`.
  scheduled: (_controller, env, context) => {
    context.waitUntil(scheduledPass(fromD1(env.DB), env))
  },
  fetch: (request, env, context) => {
    const path = new URL(request.url).pathname
    if (path === TICK_PATH) {
      return handleTick(request, env, fromD1(env.DB))
    }
    return path.startsWith(API_PREFIX)
      ? handleApi(request, env, context)
      : env.ASSETS.fetch(request).then(withReferrerPolicy)
  },
} satisfies ExportedHandler<Env>
