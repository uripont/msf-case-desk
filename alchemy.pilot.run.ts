import { existsSync } from "node:fs";

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";

// The pilot stack (D20, D21, D22): one Worker, its own EU database, nothing
// else. It is separate from the demo stack (alchemy.run.ts, stage
// `live_uripont`), so destroying or redeploying one never touches the other.
//
// Stages:
//   pilot     the real pilot, Worker `pilot` (pilot.<subdomain>.workers.dev).
//             Deployed with `pnpm pilot:deploy`.
//   test_<n>  a throwaway copy, Worker `test-<n>-pilot`, with a cron every
//             minute. `pnpm test-env:up <name>` and `pnpm test-env:down <name>`.
// Any other stage is refused here, so a stray `ALCHEMY_STAGE` in `.env` can
// never deploy this stack to the demo stage.
//
// The database is created with `jurisdiction: "eu"`. Changing that later
// replaces the database (and with a fixed name deletes the old one first), so
// it is set before the first deploy and never changed.
//
// What the database holds after a deploy: the migrations, the built-in
// templates (insert-if-absent), and, if `.local/grants-<env>.sql` exists, the
// first administrator written by `pnpm grant-admin --env pilot|test-<n>`.
// No triage cases and no accounts from `users.sql`.
//
// Test environments can use short notification timings (minutes instead of
// 48 h and 4 h) with QUOROOM_FAST_TIMINGS=1, which `pnpm test-env:up --fast`
// sets. The pilot stage always uses the production values.

const PILOT_STAGE = "pilot";
const TEST_STAGE = /^test_[a-z0-9]+$/;

// Production notification timings in minutes (D12): the review request goes out
// on publication, reminders 48 h and 4 h before the deadline.
const PRODUCTION_TIMINGS = { requestDelay: 0, firstReminder: 48 * 60, finalReminder: 4 * 60 };
const FAST_TIMINGS = { requestDelay: 0, firstReminder: 10, finalReminder: 3 };

// Workers Logs keep errors and drop what could hold report text: no invocation
// logs (they record the request URL and headers), and no tracing. The code
// writes no request bodies to the log. Workers Issues stays on for the error
// alert in alchemy.alerts.run.ts. The log test checks the logs of a test
// environment for invented report text.
//
// A test stage can turn invocation logs on with QUOROOM_INVOCATION_LOGS=1
// (`pnpm test-env:up <name> --invocation-logs`): they carry the CPU time of
// each request (see docs/decisions.md, "Logs and CPU"). The pilot stage
// ignores it.
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
    const path = yield* Path;
    const stage = yield* Alchemy.Stage;
    const root = import.meta.dirname;

    const isPilot = stage === PILOT_STAGE;
    if (!isPilot && !TEST_STAGE.test(stage)) {
      throw new Error(
        `alchemy.pilot.run.ts deploys only the stage "pilot" or a "test_<name>" stage, not "${stage}".`,
      );
    }

    // `pilot` or `test-<name>-pilot`, so test Workers never collide with it.
    const workerName = isPilot ? "pilot" : `test-${stage.slice("test_".length)}-pilot`;
    const environment = isPilot ? "pilot" : `test-${stage.slice("test_".length)}`;
    const timings =
      !isPilot && process.env.QUOROOM_FAST_TIMINGS === "1" ? FAST_TIMINGS : PRODUCTION_TIMINGS;
    const invocationLogs = !isPilot && process.env.QUOROOM_INVOCATION_LOGS === "1";

    const grantsSql = path.resolve(root, `.local/grants-${environment}.sql`);
    const database = yield* Cloudflare.D1.Database("Database", {
      jurisdiction: "eu",
      migrations: path.resolve(root, "apps/api/migrations"),
      importFiles: [
        path.resolve(root, "apps/api/seed/builtin-templates.sql"),
        ...(existsSync(grantsSql) ? [grantsSql] : []),
      ],
    });

    const pilot = yield* Cloudflare.Website.Foldkit("Pilot", {
      name: workerName,
      rootDir: path.resolve(root, "apps/web"),
      main: path.resolve(root, "apps/api/src/worker.ts"),
      assets: { runWorkerFirst: ["/api/*"] },
      env: {
        DB: database,
        NOTIFY_REQUEST_DELAY_MINUTES: String(timings.requestDelay),
        NOTIFY_FIRST_REMINDER_MINUTES: String(timings.firstReminder),
        NOTIFY_FINAL_REMINDER_MINUTES: String(timings.finalReminder),
      },
      // The notification pass: `scheduled` in apps/api/src/worker.ts.
      // One Cron Trigger per Worker, every minute on the pilot and on test
      // stages: an idle run is one query. The Free plan allows 5 on the account.
      // `/api/tick` stays unset (no TICK_SECRET): the cron does the work.
      crons: ["* * * * *"],
      observability: observabilityFor(invocationLogs),
    });

    return {
      stage,
      worker: workerName,
      url: pilot.url.as<string>(),
    };
  }),
);
