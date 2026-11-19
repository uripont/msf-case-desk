// Quoroom on OpenOrange (github.com/rivet-dev/open-orange): the same Worker,
// database and Cron Trigger as on Cloudflare, run as Rivet Actors on Rivet
// Cloud (AWS, Google Cloud or Azure) or on a self-hosted Rivet Engine.
// OpenOrange reads a Wrangler configuration; this command writes one from
// infra/quoroom.ts to .local/openorange/wrangler.jsonc, so nothing about the
// Worker is written down twice. See docs/hosting.md.
//
//   pnpm openorange dev [--port <port>] [--fast]    on this machine, data in .local/openorange
//   pnpm openorange deploy --cluster <name> [...]   an image, rolled out to a Rivet Cloud cluster
//   pnpm openorange deploy --dry-run [--outdir <d>] an image to build, for your own Rivet Engine
//   pnpm openorange database [--cluster <name>]     migrate the database (or RIVET_ENDPOINT)
//   pnpm openorange config                          only write the configuration
//
// --fast gives notification timings of minutes (D12), for trying reminders.
// `deploy` passes its other flags (--org, --region, ...) to `orange deploy`.
// `dev` and `database` apply the migrations, then import the built-in
// templates and the first administrator from `pnpm grant-admin --env
// openorange`, as the Cloudflare stack does.
//
// NOTE: the order on a cluster (docs/hosting.md). The database is a Rivet
// Actor on the Worker's nodes, so it exists only once a node runs; and with
// OpenOrange 1.0.3 any `orange d1 --remote` command stops the Cron Trigger
// until the nodes start again. So a first deployment is deploy, database,
// deploy again; a later one is database, then deploy. `deploy` never touches
// the database itself.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  COMPATIBILITY_DATE,
  LOCAL,
  MIGRATIONS,
  NOTIFICATION_CRON,
  TIMINGS,
  WEB_ASSETS,
  WORKER_ENTRY,
  importFiles,
  root,
  timingVariables,
} from "./quoroom.ts";

// NOTE: pinned, and run with `pnpm dlx`, so the repo carries no dependency
// for a host most deployments never use.
const ORANGE = ["dlx", "open-orange@1.0.3"];
const ENVIRONMENT = "openorange";
const DATABASE = "quoroom";

export const CONFIG_DIR = join(LOCAL, "openorange");
const CONFIG = join(CONFIG_DIR, "wrangler.jsonc");
// NOTE: `orange deploy` packages only the folder of the configuration (and
// the bundled Worker), so the web build is copied into it.
export const ASSETS_DIR = join(CONFIG_DIR, "assets");

/**
 * The Wrangler configuration of the Quoroom Worker, with paths relative to
 * `configDir`. OpenOrange does not apply `_headers`, so the Worker answers
 * every request (`run_worker_first`) and sets the headers itself.
 */
export const wranglerConfig = (
  options: { readonly configDir?: string; readonly fast?: boolean } = {},
) => {
  const from = (path: string) => relative(options.configDir ?? CONFIG_DIR, path);
  return {
    name: "quoroom",
    main: from(WORKER_ENTRY),
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat"],
    assets: {
      directory: from(ASSETS_DIR),
      binding: "ASSETS",
      run_worker_first: true,
      not_found_handling: "single-page-application",
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: DATABASE,
        database_id: DATABASE,
        migrations_dir: from(MIGRATIONS),
      },
    ],
    triggers: { crons: [NOTIFICATION_CRON] },
    vars: timingVariables(options.fast === true ? TIMINGS.fast : TIMINGS.production),
  };
};

const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
  throw new Error(message);
};

const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd = root,
  env: Readonly<Record<string, string>> = {},
) => {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const orange = (args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  run("pnpm", [...ORANGE, ...args, "--config", CONFIG], CONFIG_DIR, env);

/** The value of `--name value` or `--name=value` among the flags, if given. */
export const flagValue = (args: ReadonlyArray<string>, name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  return args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
};

const writeConfig = (fast = false) => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG,
    `// Written by infra/openorange.ts from infra/quoroom.ts. Do not edit.\n${JSON.stringify(wranglerConfig({ fast }), null, 2)}\n`,
  );
  console.log(`Wrote ${relative(root, CONFIG)}.`);
};

const build = (fast: boolean) => {
  writeConfig(fast);
  run("pnpm", ["--filter", "@quoroom/web", "build"]);
  rmSync(ASSETS_DIR, { recursive: true, force: true });
  cpSync(WEB_ASSETS, ASSETS_DIR, { recursive: true });
};

// NOTE: migrations first, then the imports (each idempotent), as on Cloudflare.
// `--remote` reaches RIVET_ENDPOINT if set, otherwise the cluster in
// RIVET_CLUSTER (and RIVET_ORG) or the folder's link.
const database = (where: "--local" | "--remote", env: Readonly<Record<string, string>> = {}) => {
  orange(["d1", "migrations", "apply", "DB", where], env);
  for (const file of importFiles(ENVIRONMENT)) {
    orange(["d1", "execute", "DB", where, "--yes", "--file", relative(CONFIG_DIR, file)], env);
  }
};

const devUsage = "Usage: pnpm openorange dev [--port <port>] [--fast]";
const devFlags = (args: ReadonlyArray<string>) => {
  const fast = args.includes("--fast");
  const rest = args.filter((arg) => arg !== "--fast");
  const portOk = rest.length === 2 && rest[0] === "--port" && /^\d+$/.test(rest[1] ?? "");
  if (rest.length > 0 && !portOk) fail(devUsage);
  return { fast, orangeFlags: rest };
};

const deployUsage =
  "Usage: pnpm openorange deploy --cluster <name> | --dry-run [--outdir <dir>] [--fast] [orange deploy flags]";
const databaseUsage = "Usage: pnpm openorange database [--cluster <name>] [--org <slug>]";

const RESTART =
  "Now deploy again, or restart the Worker's nodes: OpenOrange 1.0.3 stops the Cron Trigger after a remote database command, until the nodes start again.";

const main = (args: ReadonlyArray<string>) => {
  const [command, ...rest] = args;
  if (command === "config") {
    writeConfig();
  } else if (command === "dev") {
    const { fast, orangeFlags } = devFlags(rest);
    build(fast);
    database("--local");
    orange(["dev", ...orangeFlags]);
  } else if (command === "deploy") {
    const fast = rest.includes("--fast");
    const orangeFlags = rest.filter((arg) => arg !== "--fast");
    if (!orangeFlags.includes("--dry-run") && flagValue(orangeFlags, "--cluster") === undefined) {
      fail(deployUsage);
    }
    build(fast);
    orange(["deploy", ...orangeFlags]);
  } else if (command === "database") {
    const cluster = flagValue(rest, "--cluster");
    const org = flagValue(rest, "--org");
    const onlyThose = rest.every(
      (arg, at) => /^--(cluster|org)=./.test(arg) || /^--(cluster|org)$/.test(arg) || /^--(cluster|org)$/.test(rest[at - 1] ?? ""),
    );
    if (!onlyThose || (rest.length > 0 && cluster === undefined)) fail(databaseUsage);
    writeConfig();
    database("--remote", {
      ...(cluster === undefined ? {} : { RIVET_CLUSTER: cluster }),
      ...(org === undefined ? {} : { RIVET_ORG: org }),
    });
    console.log(RESTART);
  } else {
    fail(
      [devUsage, deployUsage, databaseUsage, "Usage: pnpm openorange config"]
        .map((usage, index) => (index === 0 ? usage : usage.replace("Usage:", "      ")))
        .join("\n"),
    );
  }
};

if (import.meta.main) main(process.argv.slice(2));
