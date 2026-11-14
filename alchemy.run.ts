import { existsSync } from "node:fs";

import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { Path } from "effect/Path";

// Frozen iterations are built from their git tag, extracted by
// `pnpm snapshots:prepare`, so later commits never change what they serve.
const snapshotDir = (root: string, tag: string): string => {
  const dir = `${root}/.snapshots/${tag}`;
  if (!existsSync(dir)) {
    throw new Error(`Snapshot ${tag} is missing. Run \`pnpm snapshots:prepare\` first.`);
  }
  return dir;
};

// Worker names are fixed, so the addresses stay stable. A second deployment
// on the same Cloudflare account needs a prefix, for example `test-`.
const workerName = (name: string): string =>
  `${process.env.CASE_DESK_WORKER_PREFIX ?? ""}${name}`;

// Workers Logs and Issues are free; Issues feeds the error alert in
// alchemy.alerts.run.ts.
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
    const path = yield* Path;
    const root = import.meta.dirname;

    const iter1 = yield* Cloudflare.Website.Foldkit("Web", {
      name: workerName("iter1"),
      rootDir: path.resolve(snapshotDir(root, "iter1"), "apps/web"),
      memo: snapshotMemo,
    });

    // One database shared by every version. Only this latest deployment
    // applies migrations, before its new code goes live.
    // Accounts come from `pnpm users:add`, which writes password hashes to a
    // git-ignored file. The synthetic triage cases follow it, so they can name
    // the demo account; only the frozen `iter2` shows them (D20). Both are imported after the migrations, and the
    // built-in templates (insert-if-absent, D22) before them.
    // `pnpm grant-admin --env demo` writes the first administrator's grants
    // to .local/grants-demo.sql (idempotent statements, no password).
    const usersSql = path.resolve(root, ".local/users.sql");
    const grantsSql = path.resolve(root, ".local/grants-demo.sql");
    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: path.resolve(root, "apps/api/migrations"),
      importFiles: [
        path.resolve(root, "apps/api/seed/builtin-templates.sql"),
        ...(existsSync(usersSql) ? [usersSql] : []),
        ...(existsSync(grantsSql) ? [grantsSql] : []),
        path.resolve(root, "apps/api/seed/demo-cases.sql"),
      ],
    });

    // Increment 2, frozen: its own web app and API, on the shared database.
    const iter2Dir = snapshotDir(root, "iter2");
    const iter2 = yield* Cloudflare.Website.Foldkit("Iter2", {
      name: workerName("iter2"),
      rootDir: path.resolve(iter2Dir, "apps/web"),
      main: path.resolve(iter2Dir, "apps/api/src/worker.ts"),
      memo: snapshotMemo,
      assets: { runWorkerFirst: ["/api/*"] },
      env: { DB: database },
      observability,
    });

    const app = yield* Cloudflare.Website.Foldkit("App", {
      name: workerName("app"),
      rootDir: path.resolve(root, "apps/web"),
      main: path.resolve(root, "apps/api/src/worker.ts"),
      assets: { runWorkerFirst: ["/api/*"] },
      // Quoroom only (D20): the same code as the pilot, on the demo data.
      env: { DB: database },
      // The notification pass (stage 7, D12). Only `app` has a Cron Trigger:
      // the frozen Workers (`iter1`, `iter2`, and `iter3` later) have none and
      // no TICK_SECRET, so no message is ever sent twice. Production timings
      // (48 h and 4 h), a pass every minute: a run with nothing due is one
      // query and returns at once, and housekeeping runs in the first minute of
      // each hour. Free plan: 5 Cron Triggers on
      // the account; the demo, the pilot and one test environment use 3. This
      // is an `App` update within D22; stage 10 deploys it.
      crons: ["* * * * *"],
      observability,
    });

    return {
      iter1: iter1.url.as<string>(),
      iter2: iter2.url.as<string>(),
      app: app.url.as<string>(),
    };
  }),
);
