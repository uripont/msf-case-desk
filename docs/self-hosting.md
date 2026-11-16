# Self-hosting

Quoroom runs from this repository in three ways:

- **A. On plain `workerd`**, Cloudflare's open-source Workers runtime, on your own machine or server, with the database in a SQLite file. No Cloudflare account is needed.
- **B. The pilot stack** on Cloudflare's free plan ([`alchemy.pilot.run.ts`](../alchemy.pilot.run.ts)): one Worker, its own EU database, no demo data. This is what a real pilot runs on.
- **C. The demo stack** on Cloudflare ([`alchemy.run.ts`](../alchemy.run.ts)): the latest version (`app`) next to the frozen iterations (`iter1`, `iter2`), on one shared database.

Running a pilot once it is deployed (first account, theme, units, backups, failures) is in [`pilot.md`](pilot.md).

## Prerequisites

- Node 24.11.1 or later and pnpm 10 (`corepack enable` gives you the pinned version).
- git, with the tags of the repository (`git fetch --tags` if you cloned with `--no-tags`); only the demo stack needs them.
- macOS, Linux or Windows (WSL) on x64 or arm64, where `workerd` runs.

```sh
git clone <repository-url> quoroom
cd quoroom
pnpm install
```

## Demo and pilot

The latest code is Quoroom only; the Worker has no runtime mode (D20). A demo and a pilot differ only in what is deployed and imported: the demo stack adds the frozen iterations and their synthetic triage cases, the pilot holds the built-in templates and its own accounts. The triage desk of the earlier iterations runs only in the frozen `iter1` and `iter2`; `/api/login`, `/api/logout`, `/api/session` and `/api/rpc` answer 404 in the latest version.

## Accounts

There is no sign-up page and no password is ever printed. The operator creates the first account of an environment, with People, Theme and Templates, with a one-time link; everyone else is invited in the app (see [`pilot.md`](pilot.md)).

```sh
pnpm grant-admin --env <demo|pilot|workerd|test-NAME> --email <email> --name "<name>" [--origin <address>]
pnpm grant-admin --env <...> --email <email> --reset
```

It appends idempotent SQL to `.local/grants-<env>.sql` (git-ignored) and prints the link once, valid for 72 hours. The stack of that environment imports the file on its next deploy; the `workerd` build embeds `grants-workerd.sql` on its next start. `--origin` is the address of the app, so the printed link is complete (default for `workerd`: `http://127.0.0.1:8787`). The account gets People, Theme and Templates. `--reset` makes a reset link for an account that already has a password.

`pnpm users:add` creates accounts on the demo only (`.local/users.sql`), for the frozen `iter2`. A pilot does not use it.

## Secrets

Secrets never go into the repository, a log, a URL or a chat. Only their names are listed here.

| Name | Where | How to set it |
| --- | --- | --- |
| `TICK_SECRET` | `workerd` only | In the environment of the `workerd` process (the config reads it with `fromEnvironment`). Generate it with `openssl rand -hex 24` and keep it in a file only the host user can read. Unset, `/api/tick` answers 404 |
| Cloudflare credentials | Your machine, for Alchemy | `pnpm exec alchemy profile edit --add Cloudflare` stores them in `~/.alchemy`, outside the repository. The pilot commands always use the profile `default` |

On Cloudflare the pilot and demo stacks have no Worker secret today: a Cron Trigger runs the notification pass, so `/api/tick` stays unset (404) there.

Non-secret settings are plain variables: the notification timings in minutes `NOTIFY_REQUEST_DELAY_MINUTES`, `NOTIFY_FIRST_REMINDER_MINUTES` and `NOTIFY_FINAL_REMINDER_MINUTES` (defaults 0, 2880 and 240: the request at once, reminders 48 h and 4 h before a deadline).

## A. Run on workerd

```sh
pnpm workerd                    # demo data, http://127.0.0.1:8787
pnpm workerd --mode pilot       # pilot data: built-in templates and the first account only
pnpm workerd --mode pilot 8790  # choose a port
```

It builds the web app, bundles the Worker with the migrations and starts `workerd` with:

- the same Worker code as on Cloudflare, serving the web app and the API under `/api`,
- a SQLite database in `.local/workerd-data/` (demo) or `.local/workerd-data-pilot/` (pilot), created on the first start, with the migrations applied in the same order as on Cloudflare,
- the built-in templates and `.local/grants-workerd.sql`, and with `--mode demo` also the accounts from `pnpm users:add`.

A pilot on `workerd`, from an empty folder:

```sh
pnpm grant-admin --env workerd --email admin@example.org --name "Admin Example"
pnpm workerd --mode pilot       # then open the printed link
```

Check it from another terminal:

```sh
pnpm smoke http://127.0.0.1:8787
```

To start again from an empty database, stop `workerd` and delete the data folder of that mode.

> [!NOTE]
> Plain `workerd` has no D1, so the database is a single Durable Object with SQLite storage that implements the D1 calls the Worker uses. On Cloudflare the database is D1. Either way there is one database per deployment.

### Notifications: `/api/tick` from a host cron

The notification pass sends review requests and reminders, and decides rounds whose deadline has passed. On Cloudflare a Cron Trigger starts it every minute. `workerd` fires no Cron Triggers, so a host `cron` calls `/api/tick`:

```sh
openssl rand -hex 24 > ~/.quoroom-tick-secret && chmod 600 ~/.quoroom-tick-secret
TICK_SECRET=$(cat ~/.quoroom-tick-secret) pnpm workerd --mode pilot
```

```crontab
* * * * * curl -fsS -X POST -H "Authorization: Bearer $(cat $HOME/.quoroom-tick-secret)" http://127.0.0.1:8787/api/tick >/dev/null
```

`/api/tick` answers 404 to every request unless `TICK_SECRET` is set and the request is a POST with `Authorization: Bearer <secret>`; then 200 with the counts of the pass. Running it twice at once is safe. Deadlines are also checked on every read and write, so a late pass never lets a review in after the deadline.

Put `workerd` behind your own HTTPS proxy before anyone else uses it; it listens on `127.0.0.1` only.

## B. The pilot stack on Cloudflare

Everything fits in the free plan. No payment card is needed; when a daily limit is reached the Worker stops until 00:00 UTC (limits in [`decisions.md`](decisions.md)).

1. **Create a Cloudflare account** on the free plan, and open *Workers & Pages* once in the dashboard to choose the workers.dev subdomain. Pick the final name: renaming it later breaks Alchemy's cached state (see the pitfalls below).
2. **Connect Alchemy**, with OAuth and the basic scopes:
   ```sh
   pnpm exec alchemy profile edit --add Cloudflare
   ```
3. **Grant the first account** (writes `.local/grants-pilot.sql`):
   ```sh
   pnpm grant-admin --env pilot --email <email> --name "<name>" --origin https://pilot.<subdomain>.workers.dev
   ```
4. **Plan and deploy:**
   ```sh
   pnpm pilot:plan
   pnpm pilot:deploy
   ```
   It creates the Worker `pilot` (`https://pilot.<subdomain>.workers.dev`) and its D1 database in the EU jurisdiction, applies the migrations, imports the built-in templates (only if absent) and the grants file, and adds a Cron Trigger every minute. There are no demo cases and no frozen versions.
5. **Check it:** `pnpm smoke https://pilot.<subdomain>.workers.dev`, then open the activation link.

`pnpm pilot:destroy` deletes the Worker and the database with all its data.

What the pilot stack holds fixed:

- **Stages.** `alchemy.pilot.run.ts` deploys only the stage `pilot` or a `test_<name>` stage and throws for anything else, so a stray `ALCHEMY_STAGE` can never send it elsewhere.
- **Guards.** `pnpm pilot:*` and `pnpm test-env:*` always use the Alchemy profile `default`. `pnpm pilot:*` passes on only `--yes`, `-y`, `--dry-run` and `--detailed`; `pnpm test-env:*` always deploys with `--yes` and accepts only `--fast` and `--invocation-logs`. Both refuse to run when an account-selecting variable (`ALCHEMY_PROFILE`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and the others in [`scripts/pilot-guards.mjs`](../scripts/pilot-guards.mjs)) is set in the environment or in `.env`.
- **EU jurisdiction.** Set before the first deploy and never changed: changing it replaces the database.
- **Logs.** Workers Logs keep what the code writes (errors, and the counts of each notification pass). Invocation logs, which record URLs, and traces are off; no request body is logged. Workers Issues is on.

### Test environments

A throwaway copy of the pilot stack, for checking a change on real Cloudflare before it reaches the pilot. At most one at a time (the free plan allows 10 databases and 5 Cron Triggers per account), always destroyed after use.

```sh
pnpm test-env:up test_<name> --fast   # Worker test-<name>-pilot, reminders after minutes instead of hours
pnpm test-env:down test_<name>        # deletes it, and .local/grants-test-<name>.sql
```

`--invocation-logs` turns on invocation logs, for CPU measurements; the pilot never has them. `pnpm grant-admin --env test-<name>` grants its first account.

## C. The demo stack on Cloudflare

The demo stack serves the latest version as `app` (with a Cron Trigger) and every delivered iteration, frozen at its git tag, on one shared database. Only `app` applies migrations; the rules that keep the frozen versions working are in [`compatibility.md`](compatibility.md).

```sh
pnpm snapshots:prepare            # extract the frozen iterations from their tags
pnpm infra:plan                   # preview changes
pnpm infra:deploy                 # deploy
pnpm smoke https://app.<subdomain>.workers.dev
```

Alchemy names the stage after your system user (`live_<user>`) unless `ALCHEMY_STAGE` is set. The Worker names are fixed (`app`, `iter1`, `iter2`), so one account holds one demo deployment. For a second one on the same account, set a stage and a prefix for the Worker names:

```sh
export CASE_DESK_WORKER_PREFIX=test-     # test-app, test-iter1, ...
pnpm exec alchemy --no-input plan --stage test
```

`pnpm infra:dev` runs every Worker of the stack locally with a local D1 and live reload. `pnpm exec alchemy --no-input destroy --yes` deletes the stack and its database.

## Usage and error alerts

The Workers Free plan has no usage-based alerts. It has:

- **Built-in usage notifications**, on by default: a weekly summary, and a report when a Worker's CPU time rises well above its weekly average. Check them under *Notifications* in the dashboard.
- **An alert for new errors**, from [`alchemy.alerts.run.ts`](../alchemy.alerts.run.ts), a separate stack that e-mails you when a new kind of error appears in Workers Issues:
  ```sh
  ALERT_EMAIL=you@example.org pnpm alerts:plan
  ALERT_EMAIL=you@example.org pnpm alerts:deploy
  ```
- **A manual check**: *Workers & Pages* shows the requests of the day against the 100,000 daily limit, and *Storage & Databases*, *D1* the rows read and written.

## Pitfalls

- **The workers.dev subdomain must exist before the first plan.** Open *Workers & Pages* in the dashboard once.
- **The first plan bootstraps Alchemy's state store** (a Worker called `alchemy-state-store`), so it already creates something.
- **Renaming the subdomain breaks the cached state-store address**, and `plan` hangs. Delete `~/.alchemy/profiles/<profile>/state-stores/cloudflare.json` (and `.alchemy/state/CloudflareStateStore` in the repository, if it exists), then plan again.
- **`deploy` needs `--yes`** when it runs without a terminal (`--no-input`).
- **"Snapshot iterN is missing"** stops the demo stack. Run `pnpm snapshots:prepare`, which needs the git tags.
- **"OwnedBySomeoneElse: Cannot adopt resource"** means a Worker with that name already exists on the account. Use `CASE_DESK_WORKER_PREFIX`, or remove the other deployment first.
- **A new workers.dev address can answer error 1042** for a few minutes after the first deploy.
