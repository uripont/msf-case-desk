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
  // NOTE: "1" on a test stage with invocation logs only (stage 10): each
  // answer carries `x-isolate` and `x-seq` (see `withSequence`).
  readonly REQUEST_SEQUENCE?: string
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

// NOTE: for the CPU measurements of a test stage: a random name for this
// isolate and the number of the request in it, so a request can be told warm
// (the third or later of its isolate) from cold. Off unless the stack sets
// `REQUEST_SEQUENCE`; the pilot never does.
// Random values are not allowed at the top level of a Worker, so the name is
// made on the first request.
let isolate: string | undefined
let sequence = 0
export const sequenceTag = (
  env: Pick<Env, 'REQUEST_SEQUENCE'>,
): Readonly<{ isolate: string; seq: number }> | undefined => {
  sequence += 1
  if (env.REQUEST_SEQUENCE !== '1') return undefined
  isolate ??= crypto.randomUUID().slice(0, 8)
  return { isolate, seq: sequence }
}

export const withSequence = (
  env: Pick<Env, 'REQUEST_SEQUENCE'>,
  response: Response,
): Response => {
  const tag = sequenceTag(env)
  if (tag === undefined) return response
  const headers = new Headers(response.headers)
  headers.set('x-isolate', tag.isolate)
  headers.set('x-seq', String(tag.seq))
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export default {
  // NOTE: The notification pass (stage 7). Only the Workers that have a Cron
  // Trigger run it (the pilot, test environments and the demo's `app`), so no
  // message is sent twice. It builds its own layer from `env.DB`.
  scheduled: (_controller, env, context) => {
    context.waitUntil(scheduledPass(fromD1(env.DB), env, sequenceTag(env)))
  },
  fetch: (request, env, context) => {
    const path = new URL(request.url).pathname
    if (path === TICK_PATH) {
      return handleTick(request, env, fromD1(env.DB))
    }
    return path.startsWith(API_PREFIX)
      ? handleApi(request, env, context).then(response =>
          withSequence(env, response),
        )
      : env.ASSETS.fetch(request).then(withReferrerPolicy)
  },
} satisfies ExportedHandler<Env>
