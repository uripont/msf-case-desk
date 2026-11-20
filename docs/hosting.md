# Hosting

A Quoroom deployment is always the same three things: **one Worker** that serves the web app and the API, **one SQLite database**, and a **notification pass every minute**. They are described once, in [`infra/quoroom.ts`](../infra/quoroom.ts), and each host reads that file, so the three ways to run Quoroom cannot drift apart.

| | Cloudflare | OpenOrange | Your own server |
| --- | --- | --- | --- |
| Where it runs | Cloudflare's network, on the free plan | Rivet Cloud (AWS or Google Cloud), your AWS, Google Cloud or Azure account (BYOC), or a Rivet Engine you run | Any machine that runs `workerd` |
| Runtime | Cloudflare Workers | OpenOrange (the Workers API on Node.js, by Rivet) | `workerd`, Cloudflare's open-source runtime |
| Database | D1, in the EU jurisdiction | D1, as a Rivet Actor | SQLite in a local folder |
| Notification pass | Cron Trigger | Cron Trigger, as a Rivet Actor | A host `cron` calling `POST /api/tick` |
| Command | `pnpm cloudflare:deploy` | `pnpm openorange deploy` | `pnpm workerd --mode pilot` |
| Defined in | [`infra/cloudflare.run.ts`](../infra/cloudflare.run.ts) (Alchemy) | [`infra/openorange.ts`](../infra/openorange.ts) (writes a Wrangler configuration) | [`infra/workerd.sh`](../infra/workerd.sh) and [`apps/api/workerd/quoroom.capnp`](../apps/api/workerd/quoroom.capnp) |
| Tested | The MSF pilot runs here; test environments run the rehearsal | `openorange dev` and a self-hosted Rivet Engine pass the full rehearsal; Rivet Cloud has not been tried from this repository | The browser tests (`packages/e2e`) and the rehearsal |

Pick Cloudflare when a free, managed host is fine; OpenOrange when the data has to stay in a given cloud or region you choose; your own server for a small or offline installation. Running a deployment day to day (first account, theme, backups, failures) is in [`operating.md`](operating.md).

## Before you start

- Node 24.11.1 or later and pnpm 10 (`corepack enable` gives you the pinned version).
- macOS, Linux or Windows (WSL) on x64 or arm64.

```sh
git clone <repository-url> quoroom
cd quoroom
pnpm install
```

## What every deployment holds

The same code everywhere, with no runtime mode (D20). On its first start a database gets the migrations, in order, then these imports, each safe to run again on every deploy:

1. the built-in templates, only if absent ([`apps/api/seed/builtin-templates.sql`](../apps/api/seed/builtin-templates.sql));
2. the first administrator, from `pnpm grant-admin` (below).

No demo data, unless you ask for it (`pnpm workerd` without `--mode pilot`, or the course's demo stack).

### The first administrator

There is no sign-up page and no password is ever printed. The operator makes the first account of a deployment, with People, Theme and Templates, as a one-time link; everyone else is invited in the app ([`operating.md`](operating.md)).

```sh
pnpm grant-admin --env <environment> --email <email> --name "<name>" [--origin <address>]
pnpm grant-admin --env <environment> --email <email> --reset
```

| Host | `--env` | The link reaches it |
| --- | --- | --- |
| Cloudflare | the stage: `quoroom` by default, `pilot` for the MSF pilot, `test-<name>` for a test environment | on the next `pnpm cloudflare:deploy` |
| OpenOrange | `openorange` | on the next `pnpm openorange dev` or `deploy` |
| Your own server | `workerd` | on the next start of `pnpm workerd` |
| The course's demo stack | `demo` | on the next `pnpm demo:deploy` |

It appends idempotent SQL to `.local/grants-<environment>.sql` (git-ignored) and prints the link once, valid for 72 hours. `--origin` is the address of the app, so the printed link is complete (default for the two local hosts: `http://127.0.0.1:8787`). `--reset` makes a reset link for an account that already has a password.

### Secrets and settings

Secrets never go into the repository, a log, a URL or a chat. Only their names are listed here.

| Name | Where | What |
| --- | --- | --- |
| Cloudflare credentials | Your machine | `pnpm exec alchemy profile edit --add Cloudflare` keeps them in `~/.alchemy`, outside the repository. The Cloudflare commands always use the profile `default` |
| Rivet credentials | Your machine | `orange login` (run as `pnpm dlx open-orange@1.0.3 login`), or `RIVET_CLOUD_TOKEN` |
| `TICK_SECRET` | Your own server only | In the environment of the `workerd` process. Unset, `/api/tick` answers 404 to everything |

The notification timings are plain variables, in minutes: `NOTIFY_REQUEST_DELAY_MINUTES`, `NOTIFY_FIRST_REMINDER_MINUTES` and `NOTIFY_FINAL_REMINDER_MINUTES` (0, 2880 and 240: the review request at once, reminders 48 h and 4 h before a deadline). `--fast` on a test environment or on `openorange dev` sets 10 and 3 minutes, for trying reminders.

## 1. Cloudflare

Everything fits in the free plan. No payment card is needed; when a daily limit is reached the Worker stops until 00:00 UTC (limits in [`decisions.md`](decisions.md)).

1. **Create a Cloudflare account** on the free plan, and open *Workers & Pages* once in the dashboard to choose the workers.dev subdomain. Pick the final name: renaming it later breaks Alchemy's cached state (see *Pitfalls*).
2. **Connect Alchemy**, with OAuth and the basic scopes:
   ```sh
   pnpm exec alchemy profile edit --add Cloudflare
   ```
3. **Grant the first account:**
   ```sh
   pnpm grant-admin --env quoroom --email <email> --name "<name>" --origin https://quoroom.<subdomain>.workers.dev
   ```
4. **Plan, then deploy:**
   ```sh
   pnpm cloudflare:plan
   pnpm cloudflare:deploy
   ```
   It creates the Worker `quoroom` (`https://quoroom.<subdomain>.workers.dev`) and its D1 database in the EU jurisdiction, applies the migrations, imports the templates and the grants file, and adds a Cron Trigger every minute.
5. **Check it:** `pnpm smoke https://quoroom.<subdomain>.workers.dev`, then open the activation link.

Each **stage** is a separate deployment with its own Worker and database: `pnpm cloudflare:deploy pilot` is the MSF pilot (Worker `pilot`), and any name of letters and digits works the same way. `pnpm cloudflare:destroy <stage>` deletes that Worker and its database with all its data.

What the commands hold fixed:

- **Stages.** A stage is letters and digits, or `test_<name>` through `pnpm test-env:*`. The stack refuses anything else, so a stray `ALCHEMY_STAGE` (the demo stack's `live_<user>`) can never deploy it.
- **Account.** Every command runs Alchemy with the profile `default`, and refuses to run when an account-selecting variable (`ALCHEMY_PROFILE`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and the others in [`infra/guards.mjs`](../infra/guards.mjs)) is set in the environment or in `.env`. Only `--yes`, `-y`, `--dry-run` and `--detailed` are passed on to Alchemy.
- **EU jurisdiction.** Set before the first deploy and never changed: changing it replaces the database.
- **Logs.** Workers Logs keep what the code writes (errors, and the counts of each notification pass). Invocation logs, which record URLs, and traces are off; no request body is logged. Workers Issues is on, for the alert below.

### Test environments

A throwaway copy, for checking a change on real Cloudflare before it reaches a deployment in use. At most one at a time (the free plan allows 10 databases and 5 Cron Triggers per account), always destroyed after use.

```sh
pnpm test-env:up test_<name> --fast   # Worker quoroom-test-<name>, reminders after minutes
pnpm test-env:down test_<name>        # deletes it, and .local/grants-test-<name>.sql
```

`pnpm grant-admin --env test-<name>` grants its first account. `--invocation-logs` turns on invocation logs, for CPU measurements ([`decisions.md`](decisions.md), "Logs and CPU"); no other stage has them.

### Alerts

The Workers Free plan has no usage-based alerts. It has built-in usage notifications, on by default (a weekly summary, and a report when a Worker's CPU time rises well above its weekly average), under *Notifications* in the dashboard. [`infra/alerts.run.ts`](../infra/alerts.run.ts) adds an e-mail for every new kind of error in the account's Workers (Workers Issues):

```sh
ALERT_EMAIL=you@example.org pnpm alerts:plan
ALERT_EMAIL=you@example.org pnpm alerts:deploy
```

*Workers & Pages* shows the requests of the day against the 100,000 daily limit, and *Storage & Databases*, *D1* the rows read and written.

## 2. OpenOrange

[OpenOrange](https://github.com/rivet-dev/open-orange) by Rivet runs Workers code on Node.js and maps each Cloudflare service onto Rivet: the database and the Cron Trigger become Rivet Actors, so the same Quoroom runs on a managed Rivet cluster in AWS or Google Cloud, in your own AWS, Google Cloud or Azure account, or on a Rivet Engine you host. The command writes a Wrangler configuration from [`infra/quoroom.ts`](../infra/quoroom.ts) to `.local/openorange/wrangler.jsonc` and runs the pinned CLI with `pnpm dlx open-orange@1.0.3`, so the repository carries no dependency for it.

**On your machine,** with the data in `.local/openorange/`:

```sh
pnpm grant-admin --env openorange --email <email> --name "<name>"
pnpm openorange dev                  # http://127.0.0.1:8787, then open the link
pnpm openorange dev --port 8790 --fast
```

It builds the web app, applies the migrations, imports the templates and the grants file, and starts `orange dev`, which also runs the Cron Trigger every minute. To start from an empty database, stop it and delete `.local/openorange/.open-orange`.

The database is a Rivet Actor that runs on the Worker's nodes, so it can be reached only once a node is up. And with OpenOrange 1.0.3, a remote database command (`orange d1 ... --remote`, which `pnpm openorange database` runs) stops the Cron Trigger, and with it the notification pass, until the nodes start again. So `deploy` never touches the database, and the order is:

- **A first deployment:** deploy, `pnpm openorange database`, then deploy again (or restart the nodes).
- **A later version:** `pnpm openorange database` while the old nodes run (migrations only add, so the old code is unaffected), then deploy; the new nodes start the Cron Trigger again.

**On Rivet Cloud,** managed or in your own AWS, Google Cloud or Azure account ([deploy guide](https://openorange.dev/docs/deploy/)):

```sh
pnpm dlx open-orange@1.0.3 login
pnpm grant-admin --env openorange --email <email> --name "<name>" --origin <address of the app>
pnpm openorange deploy --cluster <cluster>     # other flags go to `orange deploy`: --org, --region, ...
pnpm openorange database --cluster <cluster>   # [--org <slug>]
pnpm openorange deploy --cluster <cluster>     # first deployment only: starts the Cron Trigger again
```

The cluster's region decides where the data lives.

**On a Rivet Engine you run** ([self-hosting](https://openorange.dev/docs/deploy/#self-host)): Rivet's control plane, and the Quoroom image as its worker nodes. Run the engine first, with an admin token and a `default` pool (Rivet's guides for [Docker Compose](https://rivet.dev/docs/deploy/self-host/control-plane/docker-compose/), Kubernetes, a VM and others; `rivetdev/engine:3.1.2-rc.1` matches the RivetKit of OpenOrange 1.0.3). Then:

```sh
pnpm openorange deploy --dry-run --outdir <folder>      # a Dockerfile and its build context; calls no API
docker build --platform linux/amd64 -f <folder>/Dockerfile -t quoroom:<tag> <folder>/context
docker run -d --name quoroom -p 8080:8080 -e RIVET_ENDPOINT=https://default:<token>@<engine-host> quoroom:<tag>
RIVET_ENDPOINT=https://default:<token>@<engine-host> pnpm openorange database
docker restart quoroom                                  # first deployment only: starts the Cron Trigger again
```

The image holds no credentials; push it to a registry your servers can reach, and run as many nodes as you need. Each node logs one `notification_pass` line a minute; if none appear, restart the nodes.

> [!NOTE]
> OpenOrange does not apply the `_headers` file of the web app, so on OpenOrange the Worker answers every request (`run_worker_first`) and adds `Referrer-Policy: no-referrer` itself. The local run and a self-hosted Rivet Engine in Docker both pass the full rehearsal ([`operating.md`](operating.md)). A deploy to Rivet Cloud builds the same image and runs the same database step through Rivet Cloud's API; it needs a Rivet account and has not been run from this repository.

## 3. Your own server: workerd

```sh
pnpm grant-admin --env workerd --email <email> --name "<name>"
pnpm workerd --mode pilot           # http://127.0.0.1:8787, then open the link
pnpm workerd --mode pilot 8790      # another port
pnpm workerd                        # demo data: also the accounts from `pnpm users:add`
```

It builds the web app, bundles the Worker with the migrations and the imports, and starts `workerd` with the same Worker code as on Cloudflare and a SQLite database in `.local/workerd-data-pilot/` (or `.local/workerd-data/` for demo data), created on the first start. To start again from an empty database, stop `workerd` and delete that folder. Check it from another terminal with `pnpm smoke http://127.0.0.1:8787`.

Plain `workerd` has no D1, so the database is one Durable Object with SQLite storage that implements the D1 calls the Worker uses.

**Notifications.** `workerd` fires no Cron Triggers, so a host `cron` calls `/api/tick`:

```sh
openssl rand -hex 24 > ~/.quoroom-tick-secret && chmod 600 ~/.quoroom-tick-secret
TICK_SECRET=$(cat ~/.quoroom-tick-secret) pnpm workerd --mode pilot
```

```crontab
* * * * * curl -fsS -X POST -H "Authorization: Bearer $(cat $HOME/.quoroom-tick-secret)" http://127.0.0.1:8787/api/tick >/dev/null
```

`/api/tick` answers 404 unless `TICK_SECRET` is set and the request is a POST with `Authorization: Bearer <secret>`; then 200 with the counts of the pass. Running it twice at once is safe. Deadlines are also checked on every read and write, so a late pass never lets a review in after the deadline. Without the cron, review requests, reminders and deadlines are only noticed when someone opens the report.

`workerd` listens on `127.0.0.1` only: put it behind your own HTTPS proxy before anyone else uses it.

## The course's demo stack

The course kept every delivered iteration online next to the latest one, on one shared database: [`infra/demo.run.ts`](../infra/demo.run.ts) deploys `app` (the latest Quoroom, with a Cron Trigger) and the frozen `iter1` and `iter2`, built from their git tags, with synthetic data. How the versions share the database is in [`architecture.md`](architecture.md). A deployment for real use does not need it.

```sh
pnpm snapshots:prepare            # extract the frozen iterations from their tags (needs the git tags)
pnpm demo:plan
pnpm demo:deploy
pnpm smoke https://app.<subdomain>.workers.dev
```

Alchemy names its stage after your system user (`live_<user>`) unless `ALCHEMY_STAGE` is set. The Worker names are fixed (`app`, `iter1`, `iter2`); for a second copy on the same account, set `QUOROOM_WORKER_PREFIX=test-` and another stage. `pnpm users:add` creates demo accounts (`.local/users.sql`), shared with the frozen `iter2`.

## Pitfalls

- **The workers.dev subdomain must exist before the first plan.** Open *Workers & Pages* in the dashboard once.
- **The first plan bootstraps Alchemy's state store** (a Worker called `alchemy-state-store`), so it already creates something.
- **Renaming the subdomain breaks the cached state-store address**, and `plan` hangs. Delete `~/.alchemy/profiles/<profile>/state-stores/cloudflare.json` (and `.alchemy/state/CloudflareStateStore` in the repository, if it exists), then plan again.
- **`deploy` needs `--yes`** when it runs without a terminal.
- **"OwnedBySomeoneElse: Cannot adopt resource"** means a Worker with that name already exists on the account: choose another stage, or remove the other deployment first.
- **A new workers.dev address can answer error 1042** for a few minutes after the first deploy.
- **"Snapshot iterN is missing"** stops the demo stack. Run `pnpm snapshots:prepare`.
