# Self-hosting

Case Desk can run in two ways, both from this repository and with synthetic data only:

- **A. Locally on plain `workerd`**, Cloudflare's open-source Workers runtime, with the database in a SQLite file on your disk. No account is needed.
- **B. On your own Cloudflare account**, on the free plan, deployed with Alchemy.

Nothing in the repository is tied to one person's account. Account details come from your Alchemy profile, and accounts for signing in come from a git-ignored file you create.

## Prerequisites

- Node 24.11.1 or later and pnpm 10 (`corepack enable` gives you the pinned version).
- git, with the tags of the repository (`git fetch --tags` if you cloned with `--no-tags`).
- macOS, Linux or Windows (WSL) on x64 or arm64, where `workerd` runs.

```sh
git clone <repository-url> case-desk
cd case-desk
pnpm install
```

## Create an account to sign in

There is no sign-up page. Create each account from the command line:

```sh
pnpm users:add --email you@example.org --name "Your Name"
```

It prints a generated password once (or pass `--password` with at least 10 characters). The account is saved as a password hash in `.local/users.sql`, which is git-ignored. Run it again with the same e-mail to change the name or password. Both paths below import this file.

## A. Run locally on workerd

```sh
pnpm workerd            # http://127.0.0.1:8787
pnpm workerd 8790       # or choose a port
```

This builds the web app, bundles the Worker with the migrations, your accounts and the synthetic demo cases, and starts `workerd` with:

- the same Worker code as on Cloudflare, serving the web app and the API under `/api`,
- a SQLite database in `.local/workerd-data/`, created on first start, with the migrations applied in the same order as on Cloudflare,
- the accounts and demo cases imported on every start (the demo cases move to the current time).

Check it from another terminal:

```sh
pnpm smoke http://127.0.0.1:8787
SMOKE_EMAIL=you@example.org SMOKE_PASSWORD=... pnpm smoke http://127.0.0.1:8787
```

To start again from an empty database, stop `workerd` and delete `.local/workerd-data/`.

> [!NOTE]
> The local run keeps the database in a small Durable Object with SQLite storage, because plain `workerd` has no D1. It implements the calls the Worker uses on D1 (`prepare`, `bind`, `all`, `first` and `run`), so the storage code is the same. On Cloudflare the database is D1.

For development with live reload use `pnpm infra:dev` instead. It runs every Worker of the stack on your machine with a local D1, and prints their addresses.

## B. Deploy to your own Cloudflare account

Everything fits in Cloudflare's free plan. No payment card is needed, and without one nothing can be charged: when a daily limit is reached the Workers stop until 00:00 UTC (see the limits in [`decisions.md`](decisions.md)).

1. **Create a Cloudflare account** at dash.cloudflare.com on the free plan.
2. **Choose your workers.dev subdomain first.** In the dashboard, open *Workers & Pages* once and accept or set the subdomain (for example `my-case-desk`). Alchemy cannot deploy before it exists. Pick the final name now: renaming it later breaks Alchemy's cached state (see the pitfalls below).
3. **Connect Alchemy to the account:**
   ```sh
   pnpm exec alchemy profile edit --add Cloudflare
   ```
   Choose OAuth and the basic scopes. The login lasts about an hour; `pnpm exec alchemy profile refresh` renews it. Your credentials stay in `~/.alchemy`, outside the repository.
4. **Extract the frozen iterations** that the stack also deploys (`iter1`, `iter2`, ...):
   ```sh
   pnpm snapshots:prepare
   ```
5. **Preview** what will be created:
   ```sh
   pnpm exec alchemy --no-input plan
   ```
   The first plan on a new account creates Alchemy's own state store (a Worker called `alchemy-state-store`), so it is not purely read-only. Expect to see the D1 database and one Worker per version.
6. **Deploy:**
   ```sh
   pnpm exec alchemy --no-input deploy --yes
   ```
   The database is created, the migrations run, your accounts and the demo cases are imported, and then the Workers go live. The output lists the addresses:
   - `https://app.<your-subdomain>.workers.dev`, the latest version,
   - `https://iter1.<your-subdomain>.workers.dev`, `https://iter2...`, the frozen iterations.

   A new workers.dev address can answer with error 1042 for a few minutes after the first deploy, until it has propagated.
7. **Check it:**
   ```sh
   SMOKE_EMAIL=you@example.org SMOKE_PASSWORD=... pnpm smoke https://app.<your-subdomain>.workers.dev
   ```

Alchemy names the deployment stage after your system user (`live_<user>`). The Worker names are fixed (`app`, `iter1`, ...) so the addresses stay stable, which means one Cloudflare account holds one deployment of the stack. For a second deployment on the same account, give it its own stage and a prefix for its Worker names:

```sh
export CASE_DESK_WORKER_PREFIX=test-     # test-app, test-iter1, ...
pnpm exec alchemy --no-input plan --stage test
```

Each stage gets its own database.

### Updating

Add or change accounts with `pnpm users:add`, refresh the demo cases with `pnpm demo:refresh`, then deploy again. Only the `app` deployment applies new migrations; the snapshots read the same database. Read [`compatibility.md`](compatibility.md) before changing the schema.

### Removing everything

```sh
pnpm exec alchemy --no-input destroy --yes
```

This deletes the Workers and the database with all its data. The usage alerts, if you created them, live in a separate stack and stay (see below).

### Usage alerts (optional)

[`alchemy.alerts.run.ts`](../alchemy.alerts.run.ts) is a separate stack for e-mail alerts about usage, so destroying the app never removes them. Set `ALERT_EMAIL` in your shell (the variables are listed in [`.env.example`](../.env.example)), then run `pnpm alerts:plan` and `pnpm alerts:deploy`. If your plan offers no usage alerts, the stack says so and the guide below applies.

To check usage by hand: dashboard, *Workers & Pages*, *Overview* shows the requests of the day against the 100,000 daily limit, and *Storage & Databases*, *D1* shows rows read and written.

## Pitfalls found while setting this up

- **The workers.dev subdomain must exist before the first `plan`.** Otherwise the plan fails. Open *Workers & Pages* in the dashboard once.
- **Renaming the subdomain breaks the cached state-store address.** Alchemy then hangs on `plan`. Delete `.alchemy/state/CloudflareStateStore` in the repository and `~/.alchemy/profiles/<profile>/state-stores/cloudflare.json`, then run `plan` again.
- **`plan` bootstraps the state store** on a new account, so the first `plan` already creates a Worker.
- **`deploy` needs `--yes`** when it runs without a terminal (`--no-input`), or it stops at the approval prompt.
- **A missing snapshot stops the stack** with "Snapshot iterN is missing". Run `pnpm snapshots:prepare`, which needs the git tags.
- **"OwnedBySomeoneElse: Cannot adopt resource"** means a Worker with the same name already exists on the account, from another stage or another copy of the repository. Use `CASE_DESK_WORKER_PREFIX` as above, or remove the other deployment first.
