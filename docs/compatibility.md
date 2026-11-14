# How versions share one database

On the demo stack every delivered iteration stays online at its own address (`iter1`, `iter2`, later `iter3`) next to the latest version (`app`). They all read and write the same D1 database, so an account made in the latest version can sign in to `iter2`, and the other way round. Each version keeps working within its own features and design. The pilot stack runs no frozen versions.

A frozen version can never be fixed later, so the rules below are what keep it working while the latest version moves on.

## Rules

The rules hold for every table: the triage tables of iterations 1 and 2 and Quoroom's report tables alike. Quoroom's data lives in tables the older versions never query, and `users` keeps exactly the shape `iter2` expects.

1. **Store facts, compute the rest.** The database holds what people entered: the accounts, the reports, their drafts and reviews (and, for `iter2`, the cases and rule sets). What can be derived, such as a report's status grid or a case's priority, is never stored; each version computes it when it reads.
2. **Expand only.** A migration may add a table, add a nullable column, or add an index. It never renames, drops or changes the type of a column, and never adds `NOT NULL` without a default. `pnpm migrations:check` rejects anything else.
3. **New fields are nullable columns, or `NOT NULL` with a `DEFAULT`.** A reader that finds `NULL` uses a default in code (the triage readers of `iter2` use its `Col` helper).
4. **Write only the columns you own.** Updates name their columns (`UPDATE notification_jobs SET retry_at = ? WHERE id = ?`). No version rewrites a whole row, so an older version cannot erase a field it does not know.
5. **Read tolerantly.** A value an older version has never seen decodes as `Unknown` (`iter2`'s `Tolerant` helper and its scoring rules, in the tag). Columns a version does not know are ignored.
6. **Only the latest deploy migrates.** Migrations run when `app` is deployed, before its new code goes live. Snapshots never carry migrations of their own.
7. **Non-additive changes are the rare exception.** If a change can only be made in a non-additive way, the latest reader converts old rows (case rows record a `schemaVersion` for this), and the old columns stay in place for the snapshots.

## Adding a field safely

Say a report needs a new optional field.

1. Add a migration in `apps/api/migrations`, numbered after the last one, for example `ALTER TABLE reports ADD COLUMN programme TEXT;` (or `NOT NULL DEFAULT ''`).
2. Read it in `apps/api/src/reportRepository.ts` with a default for `NULL`, and write it only in the statements that own it.
3. Run `pnpm check`, `pnpm migrations:check` and `pnpm compat:check`.

Changing the meaning of an existing value, or adding a new value to an enum, follows the same idea: older versions show `Unknown`, which is safe. Removing a value is not; keep accepting it.

## What the tests check

- `apps/api` tests run every migration in order on SQLite and check the repository against the result.
- `pnpm compat:check` runs the repository tests of each frozen tag against the latest migrated schema: `src/d1Repository.test.ts` and `src/compat.test.ts` of `apps/api` for `iter2`, and also `src/reportRepository.test.ts` (the report repository contract, on SQLite, a fake D1 and `workerd`) once `iter3` is frozen. It runs the files a tag has, so a new tag needs no change to the script. `pnpm compat:check <ref>` checks any git ref instead, for example `HEAD` before tagging.

## Freezing a version

How a version such as `iter3` is frozen, as `iter2` was. `iter1` and `iter2` are already tags; nothing else changes for them.

1. On the commit to freeze, check it: `pnpm check` and `pnpm compat:check HEAD`.
2. Tag it: `git tag iter3`. The tag is local until the user pushes it.
3. Extract it: `pnpm snapshots:prepare` prepares every `iter*` tag into `.snapshots/<tag>` and skips those already there.
4. Add the Worker to `alchemy.run.ts`, next to `Iter2`, and return its URL (`iter3: iter3.url.as<string>()`):
   ```ts
   const iter3Dir = snapshotDir(root, "iter3");
   const iter3 = yield* Cloudflare.Website.Foldkit("Iter3", {
     name: workerName("iter3"),
     rootDir: path.resolve(iter3Dir, "apps/web"),
     main: path.resolve(iter3Dir, "apps/api/src/worker.ts"),
     memo: snapshotMemo,
     assets: { runWorkerFirst: ["/api/*"] },
     env: { DB: database },
     observability,
   });
   ```
   No `crons` and no `TICK_SECRET`: only `app` runs the notification pass, so nothing is sent twice.
5. `pnpm infra:plan` must show `Iter3` created and nothing replaced or deleted. Creating it needs the owner's explicit agreement (D22). Then `pnpm infra:deploy` and `pnpm smoke https://iter3.<subdomain>.workers.dev`.
6. From then on `pnpm compat:check` runs `iter3`'s contract tests on every later schema, and a migration that breaks it fails.
