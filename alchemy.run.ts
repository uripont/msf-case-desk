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
      name: "iter1",
      rootDir: path.resolve(snapshotDir(root, "iter1"), "apps/web"),
      memo: snapshotMemo,
    });

    const app = yield* Cloudflare.Website.Foldkit("App", {
      name: "app",
      rootDir: path.resolve(root, "apps/web"),
    });

    return {
      iter1: iter1.url.as<string>(),
      app: app.url.as<string>(),
    };
  }),
);
