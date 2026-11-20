# Development

Running Quoroom on your machine, the scripts of the repository, and what the tests check. Hosting it for real is in [`hosting.md`](hosting.md); how the code is laid out is in [`architecture.md`](architecture.md).

## Getting started

You need Node 24.11.1 or later and pnpm 10 (`corepack enable` gives you the pinned version).

```sh
pnpm install
pnpm grant-admin --env workerd --email admin@example.org --name "Admin Example"   # prints a one-time link
pnpm workerd --mode pilot   # http://127.0.0.1:8787, then open the link
```

`pnpm openorange dev` runs the same thing on OpenOrange instead (`--env openorange` for the link). `pnpm workerd` without `--mode` adds the demo accounts from `pnpm users:add`.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm workerd [--mode demo\|pilot] [port]` | Builds and serves everything on plain `workerd` with a local database |
| `pnpm openorange dev\|deploy\|database\|config` | Runs or deploys Quoroom on OpenOrange, on Rivet Cloud or your own Rivet Engine |
| `pnpm cloudflare:plan\|deploy\|destroy [stage]` | Quoroom on Cloudflare, one Worker and database per stage (`quoroom` by default) |
| `pnpm test-env:up\|down test_<name>` | A throwaway test environment on Cloudflare |
| `pnpm alerts:plan\|deploy` | An e-mail for new errors in the account's Workers |
| `pnpm grant-admin` | First account of an environment (People, Theme, Templates): a one-time activation link, `--reset` for a reset link |
| `pnpm smoke <address>` | Read-only check of a deployment |
| `pnpm rehearsal <address>` | The pilot script, driven through the web UI by seven invented people |
| `pnpm --filter @quoroom/e2e e2e` | Browser tests on `workerd`: the pilot path and every route at phone and desktop width |
| `pnpm check` | Typecheck, lint, the migration check, tests and build, as CI does |
| `pnpm compat:check` | Runs each frozen version's storage tests on the latest schema |
| `pnpm demo:plan\|deploy`, `snapshots:prepare`, `users:add` | The course's demo stack, with the frozen iterations |

## Testing

- **Property tests** (fast-check) on the pure rules: generated templates, permissions from a template's roles, approval rules, comparison of drafts, redaction, numbering.
- **Repository contract tests**, one suite run in memory, on SQLite with every migration, on a fake D1 and on `workerd`, with the number of queries each operation may make.
- **API tests** with several accounts against the Worker's routes, above all what each one must not see.
- **Story and scene tests** (Foldkit) for every screen, without a browser.
- **Browser tests** (`packages/e2e`) on `workerd` in Chromium and Firefox: the pilot path, every route at 375 and 1280 px in its loaded, empty, loading and error states, keyboard use. The rehearsal runs the pilot script end to end on any host.
- **Compatibility**: `pnpm migrations:check` rejects migrations that would break an older version, and `pnpm compat:check` runs the storage tests of every frozen version on the latest schema ([`architecture.md`](architecture.md#how-versions-share-one-database)).

All data in the tests is synthetic.
