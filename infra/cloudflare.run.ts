import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import {
  API_ROUTES,
  MIGRATIONS,
  NOTIFICATION_CRON,
  TIMINGS,
  WEB_APP,
  WORKER_ENTRY,
  importFiles,
  timingVariables,
} from "./quoroom.ts";

// Quoroom on Cloudflare's free plan: one Worker, its own EU database, a Cron
// Trigger for the notification pass, nothing else. Run it through
// `pnpm cloudflare:*` and `pnpm test-env:*` (infra/cloudflare.mjs), which pick
// the stage and the account; see docs/hosting.md.
//
// Stages, one deployment each:
//   <name>    letters and digits, `quoroom` by default: Worker `<name>`
//             (<name>.<subdomain>.workers.dev). The MSF pilot is the stage `pilot`.
//   test_<n>  a throwaway copy, Worker `quoroom-test-<n>`, which may use
//             notification timings of minutes and invocation logs.
// Any other stage is refused, so a stray `ALCHEMY_STAGE` (the demo stack's
// `live_<user>`) can never deploy this stack.
//
// The database is created with `jurisdiction: "eu"`. Changing that later
// replaces the database (and with a fixed name deletes the old one first), so
// it is set before the first deploy and never changed.
//
// What the database holds after a deploy: the migrations, the built-in
// templates (insert-if-absent), and, if `.local/grants-<environment>.sql`
// exists, the first administrator from `pnpm grant-admin --env <environment>`.
// No demo data.

const STAGE = /^[a-z][a-z0-9]*$/;
const TEST_STAGE = /^test_[a-z0-9]+$/;

// Workers Logs keep errors and drop what could hold report text: no invocation
// logs (they record the request URL and headers), and no tracing. The code
// writes no request bodies to the log. Workers Issues stays on for the error
// alert in alerts.run.ts. A test stage can turn invocation logs on, for the
// CPU measurements (docs/decisions.md, "Logs and CPU").
const observabilityFor = (invocationLogs: boolean) => ({
  enabled: true,
  logs: { enabled: true, invocationLogs, persist: true },
  traces: { enabled: false },
  issues: { enabled: true },
});

export default Alchemy.Stack(
  "Quoroom",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;

    const isTest = TEST_STAGE.test(stage);
    if (!isTest && !STAGE.test(stage)) {
      throw new Error(
        `infra/cloudflare.run.ts deploys a stage of letters and digits or "test_<name>", not "${stage}".`,
      );
    }

    const testName = stage.slice("test_".length);
    const workerName = isTest ? `quoroom-test-${testName}` : stage;
    // NOTE: the name `pnpm grant-admin --env` takes, and so the grants file.
    const environment = isTest ? `test-${testName}` : stage;
    const timings = isTest && process.env.QUOROOM_FAST_TIMINGS === "1" ? TIMINGS.fast : TIMINGS.production;
    const invocationLogs = isTest && process.env.QUOROOM_INVOCATION_LOGS === "1";

    const database = yield* Cloudflare.D1.Database("Database", {
      jurisdiction: "eu",
      migrations: MIGRATIONS,
      importFiles: [...importFiles(environment)],
    });

    // NOTE: the resource ID stays "Pilot", as when the first stage (the MSF
    // pilot) was deployed: renaming it would replace that Worker.
    const worker = yield* Cloudflare.Website.Foldkit("Pilot", {
      name: workerName,
      rootDir: WEB_APP,
      main: WORKER_ENTRY,
      assets: { runWorkerFirst: API_ROUTES },
      env: { DB: database, ...timingVariables(timings) },
      // `/api/tick` stays unset (no TICK_SECRET): the cron does the work.
      crons: [NOTIFICATION_CRON],
      observability: observabilityFor(invocationLogs),
    });

    return {
      stage,
      worker: workerName,
      url: worker.url.as<string>(),
    };
  }),
);
