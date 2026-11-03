# How versions share one database

Every delivered iteration stays online at its own address (`iter2`, `iter3`, ...) next to the latest version (`app`). They all read and write the same D1 database, so a case entered in the latest version shows up in an older one, and the other way round. Each version keeps working within its own features and design.

A frozen version can never be fixed later, so the rules below are what keep it working while the latest version moves on.

## Rules

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
- `pnpm compat:check` runs the repository tests of each frozen tag against the latest migrated schema.
