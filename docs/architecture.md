# Architecture

## Who it is for, and where it stops

Quoroom is for people who write reports together and have them approved by a committee. Its first users are the case managers and committee members of MSF's ethics and behaviour functions, starting with the Ethics & Behaviour Unit. It is an **internal** tool: it starts from a case that has already arrived and never takes reports from reporters.

At MSF, reporters use the Integrity Line, a hosted platform run by EQS Group per operational centre, to make a complaint or ask a question, with a personal secure account for follow-up. (This was read from MSF's public pages only; nothing was submitted and no internal system was accessed.)

| Quoroom does | Quoroom does not |
| --- | --- |
| Draft, redact, review and approve the reports about a case | Collect complaints or questions from reporters |
| Reference a case by its identifier (the case file's reference) | Copy case content out of the Integrity Line |
| Keep every draft, revision, review and decision with an audit log | Create reporter accounts or secure reporter messaging |
| Record the committee's approval of a report | Replace the committee's authority over outcomes |

Nothing in the code is specific to MSF: templates, roles and their permissions, units and the look are data, set in the app ([`templates.md`](templates.md)).

## How it is built

```text
infra/            how Quoroom is hosted: quoroom.ts (what every deployment is),
                  cloudflare.run.ts, openorange.ts, workerd.sh, demo.run.ts, alerts.run.ts
apps/api/         the Worker: the RPC API, authorization, redaction, the notification pass
apps/web/         the web app (Foldkit), served by the same Worker as static assets
packages/domain/  pure rules: templates, the report flow, approval, redaction, the API contract
packages/pdf/     the PDF renderer, for the browser and Node
packages/e2e/     browser tests and the rehearsal
```

- **One Worker per deployment** serves the web app and the API under `/api`. The API is one Effect RPC group that both the web app and the Worker import ([`api.md`](api.md)), so a change to it fails the typecheck on both sides.
- **Pure rules.** `packages/domain` has no clock, no randomness, no I/O and no UI: every rule is a pure function, the same in the browser, the Worker and the tests.
- **One SQLite database**, behind a narrow SQL seam (text and numbers only) with three adapters: D1 on Cloudflare and OpenOrange, a Durable Object with SQLite storage on `workerd`, and Node's SQLite in tests. Images are stored in it too, in chunks.
- **The notification pass** runs every minute from a Cron Trigger (or `POST /api/tick` on `workerd`): it sends review requests and reminders to the in-app inbox and decides rounds whose deadline has passed ([`decisions.md`](decisions.md), "The notification pass").
- **PDFs are made in the browser** from the stored versions, never stored.

### Notifications outside the app

The notification pass delivers each job through a `NotificationChannel` (`apps/api/src/quoroom/notify.ts`), and the in-app inbox is the only one. E-mail, WhatsApp or any other way to reach people outside the app would be a second channel: an integration with an outside provider, left to whoever deploys Quoroom, because it depends on that provider (its account, cost and data-protection terms) and on the host (a `send_email` binding on Cloudflare; a provider's HTTP API and a secret on OpenOrange or `workerd`). Options and costs are in [`decisions.md`](decisions.md), "Notifications outside the app". Such a channel:

- is added next to the inbox in `notify.ts`, with its binding or secret described once in `infra/quoroom.ts` for every host;
- sends at least once: a pass that stops after sending and before finishing the job sends again, so it receives the job's idempotency key and attempt number;
- carries a notice and a link, never report content, so redaction stays on the server.

## How versions share one database

On the course's demo stack every delivered iteration stays online at its own address (`iter1`, `iter2`) next to the latest version (`app`). They all read and write the same D1 database, so an account made in the latest version can sign in to `iter2`, and the other way round. A frozen version can never be fixed later, so the rules below are what keep it working while the latest version moves on. Every other deployment runs only the latest version, but follows the same rules, which is also what makes rolling back the code safe.

### Rules

The rules hold for every table: the triage tables of iterations 1 and 2 and Quoroom's report tables alike. Quoroom's data lives in tables the older versions never query, and `users` keeps exactly the shape `iter2` expects.

1. **Store facts, compute the rest.** The database holds what people entered: the accounts, the reports, their drafts and reviews (and, for `iter2`, the cases and rule sets). What can be derived, such as a report's status grid or a case's priority, is never stored; each version computes it when it reads.
2. **Expand only.** A migration may add a table, add a nullable column, or add an index. It never renames, drops or changes the type of a column, and never adds `NOT NULL` without a default. `pnpm migrations:check` rejects anything else.
3. **New fields are nullable columns, or `NOT NULL` with a `DEFAULT`.** A reader that finds `NULL` uses a default in code (the triage readers of `iter2` use its `Col` helper).
4. **Write only the columns you own.** Updates name their columns (`UPDATE notification_jobs SET retry_at = ? WHERE id = ?`). No version rewrites a whole row, so an older version cannot erase a field it does not know.
5. **Read tolerantly.** A value an older version has never seen decodes as `Unknown` (`iter2`'s `Tolerant` helper and its scoring rules, in the tag). Columns a version does not know are ignored.
6. **Only the latest deploy migrates.** Migrations run when the latest version is deployed, before its new code goes live. Snapshots never carry migrations of their own.
7. **Non-additive changes are the rare exception.** If a change can only be made in a non-additive way, the latest reader converts old rows (case rows record a `schemaVersion` for this), and the old columns stay in place for the snapshots.

### Adding a field safely

Say a report needs a new optional field.

1. Add a migration in `apps/api/migrations`, numbered after the last one, for example `ALTER TABLE reports ADD COLUMN programme TEXT;` (or `NOT NULL DEFAULT ''`).
2. Read it in `apps/api/src/reportRepository.ts` with a default for `NULL`, and write it only in the statements that own it.
3. Run `pnpm check`, `pnpm migrations:check` and `pnpm compat:check`.

Changing the meaning of an existing value, or adding a new value to an enum, follows the same idea: older versions show `Unknown`, which is safe. Removing a value is not; keep accepting it.

### What the tests check

- `apps/api` tests run every migration in order on SQLite and check the repository against the result.
- `pnpm compat:check` runs the repository tests of each tag against the latest migrated schema: `src/d1Repository.test.ts` and `src/compat.test.ts` of `apps/api` for `iter2`, and also `src/reportRepository.test.ts` (the report repository contract, on SQLite, a fake D1 and `workerd`) for `iter3`. It runs the files a tag has, so a new tag needs no change to the script. `pnpm compat:check <ref>` checks any git ref instead, for example `HEAD` before tagging.

### Freezing a version

How a version is frozen next to the others, as `iter2` was. Iteration 3 is tagged `iter3`, so steps 1 and 2 are done for it and `pnpm compat:check` already runs its contract tests; it is not deployed as a frozen Worker.

1. On the commit to freeze, check it: `pnpm check` and `pnpm compat:check HEAD`.
2. Tag it: `git tag iter<n>`.
3. Extract it: `pnpm snapshots:prepare` prepares every `iter*` tag into `.snapshots/<tag>` and skips those already there.
4. Add the Worker to `infra/demo.run.ts`, next to `Iter2`, and return its URL. No `crons` and no `TICK_SECRET`: only `app` runs the notification pass, so nothing is sent twice.
   ```ts
   const iter3Dir = snapshotDir("iter3");
   const iter3 = yield* Cloudflare.Website.Foldkit("Iter3", {
     name: workerName("iter3"),
     rootDir: join(iter3Dir, "apps/web"),
     main: join(iter3Dir, "apps/api/src/worker.ts"),
     memo: snapshotMemo,
     assets: { runWorkerFirst: API_ROUTES },
     env: { DB: database },
     observability,
   });
   ```
5. `pnpm demo:plan` must show the new Worker created and nothing replaced or deleted (D22). Then `pnpm demo:deploy` and `pnpm smoke https://iter3.<subdomain>.workers.dev`.
6. From then on `pnpm compat:check` runs the tag's contract tests on every later schema, and a migration that breaks it fails.
