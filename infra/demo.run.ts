import { existsSync } from "node:fs";
import { join } from "node:path";

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

import {
  API_ROUTES,
  DEMO_CASES,
  MIGRATIONS,
  NOTIFICATION_CRON,
  WEB_APP,
  WORKER_ENTRY,
  importFiles,
  root,
} from "./quoroom.ts";

// The course's demo stack: every iteration side by side on one shared
// database, with synthetic data. A deployment of Quoroom for real use is
// infra/cloudflare.run.ts instead (docs/hosting.md).
//
//   iter1, iter2  frozen iterations, built from their git tags
//   app           the latest Quoroom, the same code as any other deployment (D20)
//
// The stack and resource names ("TriageDesk", "Web", ...) date from the first
// iteration and stay: renaming one replaces what it deployed.

// Frozen iterations are built from their git tag, extracted by
// `pnpm snapshots:prepare`, so later commits never change what they serve.
const snapshotDir = (tag: string): string => {
  const dir = join(root, ".snapshots", tag);
  if (!existsSync(dir)) {
    throw new Error(`Snapshot ${tag} is missing. Run \`pnpm snapshots:prepare\` first.`);
  }
  return dir;
};

// Worker names are fixed, so the addresses stay stable. A second deployment
// on the same Cloudflare account needs a prefix, for example `test-`.
const workerName = (name: string): string => `${process.env.QUOROOM_WORKER_PREFIX ?? ""}${name}`;

// Workers Logs and Issues are free; Issues feeds the error alert in
// alerts.run.ts.
const observability = {
  enabled: true,
  logs: { enabled: true, invocationLogs: true },
  issues: { enabled: true },
};

const snapshotMemo = {
  include: ["src/**", "public/**", "index.html", "vite.config.ts", "package.json"],
  lockfile: true,
};

export default Alchemy.Stack(
  "TriageDesk",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const iter1 = yield* Cloudflare.Website.Foldkit("Web", {
      name: workerName("iter1"),
      rootDir: join(snapshotDir("iter1"), "apps/web"),
      memo: snapshotMemo,
    });

    // One database shared by every version. Only this latest deployment
    // applies migrations, before its new code goes live. After them: the
    // built-in templates, the demo accounts from `pnpm users:add`, the first
    // administrator from `pnpm grant-admin --env demo`, and the synthetic
    // triage cases, which name the demo account and only `iter2` shows (D20).
    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: MIGRATIONS,
      importFiles: [...importFiles("demo", { demoAccounts: true }), DEMO_CASES],
    });

    // Iteration 2, frozen: its own web app and API, on the shared database.
    const iter2Dir = snapshotDir("iter2");
    const iter2 = yield* Cloudflare.Website.Foldkit("Iter2", {
      name: workerName("iter2"),
      rootDir: join(iter2Dir, "apps/web"),
      main: join(iter2Dir, "apps/api/src/worker.ts"),
      memo: snapshotMemo,
      assets: { runWorkerFirst: API_ROUTES },
      env: { DB: database },
      observability,
    });

    const app = yield* Cloudflare.Website.Foldkit("App", {
      name: workerName("app"),
      rootDir: WEB_APP,
      main: WORKER_ENTRY,
      assets: { runWorkerFirst: API_ROUTES },
      env: { DB: database },
      // The notification pass (D12). Only `app` has a Cron Trigger: the
      // frozen Workers have none and no TICK_SECRET, so no message is ever
      // sent twice. Production timings (48 h and 4 h). Free plan: 5 Cron
      // Triggers on the account; the demo, the pilot and one test environment
      // use 3.
      crons: [NOTIFICATION_CRON],
      observability,
    });

    return {
      iter1: iter1.url.as<string>(),
      iter2: iter2.url.as<string>(),
      app: app.url.as<string>(),
    };
  }),
);
