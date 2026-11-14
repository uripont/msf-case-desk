# How versions share one database

On the demo stack every delivered iteration stays online at its own address (`iter1`, `iter2`, later `iter3`) next to the latest version (`app`). They all read and write the same D1 database, so a case entered in the latest version shows up in an older one, and the other way round. Each version keeps working within its own features and design. The pilot stack runs no frozen versions.

A frozen version can never be fixed later, so the rules below are what keep it working while the latest version moves on.

## Rules

The rules hold for every table: the triage tables of iterations 1 and 2 and Quoroom's report tables alike. Quoroom's data lives in tables the older versions never query, and `users` keeps exactly the shape `iter2` expects.

1. **Store facts, compute the rest.** The database holds what people entered: the case, its triage factors, the rule sets, the accounts. Priority, SLA state and groups are never stored. Each version computes them when it reads, with its own scoring engine.
2. **Expand only.** A migration may add a table, add a nullable column, or add an index. It never renames, drops or changes the type of a column, and never adds `NOT NULL` without a default. `pnpm migrations:check` rejects anything else.
3. **New fields are nullable columns with a default in code.** A reader that finds `NULL` or no column at all uses the default (the `Col` helper in `packages/domain/src/compat.ts`).
4. **Write only the columns you own.** Updates name their columns (`UPDATE cases SET risk = ? WHERE id = ?`). No version rewrites a whole row, so an older version cannot erase a field it does not know.
5. **Read tolerantly.** A value an older version has never seen decodes as `Unknown` (the `Tolerant` helper) and is scored as described in [`triage-rules.md`](triage-rules.md). Columns a version does not know are ignored.
6. **Only the latest deploy migrates.** Migrations run when `app` is deployed, before its new code goes live. Snapshots never carry migrations of their own.
7. **`schemaVersion` is for the rare exception.** Each case row records the version of the entry format it was written with. If a change can only be made in a non-additive way, the latest reader converts old rows by `schemaVersion` (with `Schema.decodeTo`), and the old columns stay in place for the snapshots.

## Adding a field safely

Say the unit asks for a new optional field, *affected programme*.

1. Add a migration in `apps/api/migrations`, numbered after the last one:
   ```sql
   ALTER TABLE cases ADD COLUMN programme TEXT;
   ```
2. Add the field to `CaseEntry` in `packages/domain/src/entry.ts` as `Schema.optionalKey(...)`.
3. Add it to the `Case` reader with `Col(Schema.String, '')`.
4. Write it in its own `UPDATE` or in the `INSERT` of new cases. Do not touch it anywhere else.
5. Run `pnpm check` (the compatibility tests decode rows from the new schema in the old readers) and `pnpm migrations:check`.

Changing the meaning of an existing value, or adding a new value to an enum, follows the same idea: older versions will show `Unknown` with a reason, which is safe. Removing a value is not; keep accepting it.

## What the tests check

- `packages/domain/src/compat.test.ts`: an old reader decodes a new enum value as `Unknown`, a new reader gives a missing or `NULL` column its default, and an old reader ignores new columns.
- `packages/domain/src/triage.test.ts`: any stored case, including unrecognised values, is scored without failing and explains itself.
- `apps/api` tests run every migration in order on SQLite and check the repository against the result.
- `pnpm compat:check` runs the repository tests of each frozen tag against the latest migrated schema: `src/d1Repository.test.ts` and `src/compat.test.ts` of `apps/api` for `iter2`, and also `src/reportRepository.test.ts` (the report repository contract, on SQLite, a fake D1 and `workerd`) once `iter3` is frozen. It runs the files a tag has, so a new tag needs no change to the script. `pnpm compat:check <ref>` checks any git ref instead, for example `HEAD` before tagging.

## Freezing a version

How `iter3` is frozen (plan, stage 11 step 5), as `iter2` was. `iter1` and `iter2` are already tags; nothing else changes for them.

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
     env: { DB: database, RUNTIME_MODE: "demo" },
     observability,
   });
   ```
   No `crons` and no `TICK_SECRET`: only `app` runs the notification pass, so nothing is sent twice. `RUNTIME_MODE` must be set, or the frozen Worker is a pilot.
5. `pnpm infra:plan` must show `Iter3` created and nothing replaced or deleted. Creating it needs the owner's explicit agreement (D22). Then `pnpm infra:deploy` and `pnpm smoke https://iter3.<subdomain>.workers.dev`.
6. From then on `pnpm compat:check` runs `iter3`'s contract tests on every later schema, and a migration that breaks it fails.
