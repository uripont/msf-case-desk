import { existsSync } from "node:fs";
import { join } from "node:path";

// What every Quoroom deployment is, wherever it runs: one Worker that serves
// the web app and the API, one relational database, and a notification pass
// every minute. The Cloudflare stacks (cloudflare.run.ts, demo.run.ts) and the
// workerd build (apps/api/scripts/build-workerd.mjs) both read it from here, so
// the ways to host Quoroom cannot drift apart.
//
// Plain data and paths only: no import of the app's code, which uses another
// Effect version (docs/decisions.md, "Two Effect versions on purpose").

export const root = join(import.meta.dirname, "..");

/** The Foldkit web app; its build (`dist/`) is the Worker's static assets. */
export const WEB_APP = join(root, "apps/web");
export const WEB_ASSETS = join(WEB_APP, "dist");
/** The Worker's entry on Cloudflare. workerd has its own (apps/api/src/workerd.ts). */
export const WORKER_ENTRY = join(root, "apps/api/src/worker.ts");
/** Expand-only SQL migrations, applied in order before new code goes live. */
export const MIGRATIONS = join(root, "apps/api/migrations");
export const BUILTIN_TEMPLATES = join(root, "apps/api/seed/builtin-templates.sql");
/** Synthetic triage cases, only for the frozen `iter2` on the demo stack. */
export const DEMO_CASES = join(root, "apps/api/seed/demo-cases.sql");
/** Git-ignored files written on this machine: accounts, grants, local data. */
export const LOCAL = join(root, ".local");

/** The Workers runtime version, as in apps/api/workerd/quoroom.capnp. */
export const COMPATIBILITY_DATE = "2026-10-01";

/** Requests the Worker answers before the static assets are looked up. */
export const API_ROUTES = ["/api/*"];

/**
 * The notification pass (`scheduled` in apps/api/src/worker.ts). An idle run
 * is one query. workerd has no Cron Triggers, so a host cron calls
 * `POST /api/tick` instead (docs/hosting.md).
 */
export const NOTIFICATION_CRON = "* * * * *";

/**
 * Notification timings in minutes (D12): the review request on publication,
 * reminders 48 h and 4 h before the deadline. Test environments use minutes.
 */
export const TIMINGS = {
  production: { requestDelay: 0, firstReminder: 48 * 60, finalReminder: 4 * 60 },
  fast: { requestDelay: 0, firstReminder: 10, finalReminder: 3 },
} as const;

export const timingVariables = (timings: (typeof TIMINGS)[keyof typeof TIMINGS]) => ({
  NOTIFY_REQUEST_DELAY_MINUTES: String(timings.requestDelay),
  NOTIFY_FIRST_REMINDER_MINUTES: String(timings.firstReminder),
  NOTIFY_FINAL_REMINDER_MINUTES: String(timings.finalReminder),
});

/** The first administrator of an environment, written by `pnpm grant-admin --env <environment>` (D21). */
export const grantsFile = (environment: string, local: string = LOCAL): string =>
  join(local, `grants-${environment}.sql`);

/**
 * The SQL an environment imports after the migrations, in order. Every file
 * is idempotent, so it can run again on each deploy or start: the built-in
 * templates (insert-if-absent), the demo accounts from `pnpm users:add` (demo
 * data only, never a real deployment) and the first administrator.
 */
export const importFiles = (
  environment: string,
  options: { readonly demoAccounts?: boolean; readonly local?: string } = {},
): ReadonlyArray<string> => {
  const local = options.local ?? LOCAL;
  return [
    BUILTIN_TEMPLATES,
    ...(options.demoAccounts === true ? [join(local, "users.sql")] : []),
    grantsFile(environment, local),
  ].filter((file) => existsSync(file));
};
