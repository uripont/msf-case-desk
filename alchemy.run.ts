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
    // git-ignored file. The synthetic demo cases follow it, so they can name
    // the demo account. Both are imported after the migrations.
    const usersSql = path.resolve(root, ".local/users.sql");
    const database = yield* Cloudflare.D1.Database("Database", {
      migrations: path.resolve(root, "apps/api/migrations"),
      importFiles: [
        ...(existsSync(usersSql) ? [usersSql] : []),
        path.resolve(root, "apps/api/seed/demo-cases.sql"),
      ],
    });

    const app = yield* Cloudflare.Website.Foldkit("App", {
      name: workerName("app"),
      rootDir: path.resolve(root, "apps/web"),
      main: path.resolve(root, "apps/api/src/worker.ts"),
      assets: { runWorkerFirst: ["/api/*"] },
      env: { DB: database },
    });

    return {
      iter1: iter1.url.as<string>(),
      app: app.url.as<string>(),
    };
  }),
);
