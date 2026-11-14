import { Layer } from 'effect'

import { makeApp } from './app'
import { withReferrerPolicy } from './headers'
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
  // NOTE: the `NOTIFY_*_MINUTES` timings (D12) and `TICK_SECRET` are in `TickEnv`.
  // Both the handlers that write the jobs and the pass that sends them read the
  // timings, so a test environment's minutes apply to both.
}

const API_PREFIX = '/api/'

// NOTE: the repositories and service layers hold no request state (plain
// functions over the database binding and the stack's settings), so they are
// made once per isolate and made again only if the binding or the settings
// change.
type Layers = Readonly<{
  db: D1Database
  config: ReturnType<typeof notificationConfigFrom>
  repository: ReturnType<typeof layerSql>
  quoroom: Parameters<typeof makeApp>[1]
}>
let layers: Layers | undefined
const layersFor = (env: Env): Layers => {
  const config = notificationConfigFrom(env)
  if (layers?.db !== env.DB || layers.config !== config) {
    layers = {
      db: env.DB,
      config,
      repository: layerSql(env.DB),
      quoroom: Layer.mergeAll(
        layerSqlReport(fromD1(env.DB)),
        QuoroomServicesLive(config),
      ),
    }
  }
  return layers
}

// NOTE: the RPC servers are built for each request and disposed after it.
// Workers do not let one request's I/O run inside fibers started by another
// request, so an RPC server cannot be shared across requests.
const handleApi = async (
  request: Request,
  env: Env,
  context: ExecutionContext,
): Promise<Response> => {
  const { repository, quoroom } = layersFor(env)
  const app = makeApp(repository, quoroom)
  try {
    return await app.handle(request)
  } finally {
    context.waitUntil(app.dispose())
  }
}

export default {
  // NOTE: The notification pass. Only the Workers that have a Cron
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
