import { Layer } from 'effect'

import { makeApp } from './app'
import { withReferrerPolicy } from './headers'
import { modeOf } from './runtimeMode'
import { layerSql } from './d1Repository'
import { QuoroomServicesLive } from './quoroom/core'
import { layerSqlReport } from './reportRepository'
import { fromD1 } from './sql'

export type Env = {
  readonly ASSETS: Fetcher
  readonly DB: D1Database
  // NOTE: `demo` or `pilot` (D20), set by the stack. Unset means `pilot`; any
  // other value is a configuration error (see `modeOf`).
  readonly RUNTIME_MODE?: string
  // NOTE: Notification timings in minutes, set by the pilot stack (D12). Unset
  // means the production values of `DEFAULT_NOTIFICATION_CONFIG`. Nothing reads
  // them until the notification pass exists (stage 7).
  readonly NOTIFY_REQUEST_DELAY_MINUTES?: string
  readonly NOTIFY_FIRST_REMINDER_MINUTES?: string
  readonly NOTIFY_FINAL_REMINDER_MINUTES?: string
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
    Layer.mergeAll(layerSqlReport(fromD1(env.DB)), QuoroomServicesLive),
    mode.mode,
  )
  try {
    return await app.handle(request)
  } finally {
    context.waitUntil(app.dispose())
  }
}

// NOTE: PLACEHOLDER until stage 7. The stacks that have a cron (the pilot,
// and test environments of it) call this on every schedule; it does nothing
// and is safe to run any number of times. Stage 7 replaces the body with the
// notification pass, which builds its own layer from `layerSql(env.DB)`.
const runNotificationPass = async (
  _env: Env,
  _scheduledTime: number,
): Promise<void> => {}

export default {
  scheduled: (controller, env, context) => {
    context.waitUntil(runNotificationPass(env, controller.scheduledTime))
  },
  fetch: (request, env, context) =>
    new URL(request.url).pathname.startsWith(API_PREFIX)
      ? handleApi(request, env, context)
      : env.ASSETS.fetch(request).then(withReferrerPolicy),
} satisfies ExportedHandler<Env>
