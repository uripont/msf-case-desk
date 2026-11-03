# Decisions

## Two Effect versions on purpose

Foldkit 0.169 pins `effect` to exactly 4.0.0 in its peer dependencies. Alchemy 2.0.0-beta.84 requires `effect` 4.0.5 or later. They cannot share one version.

The repository therefore uses two:

- `apps/web` and `packages/domain` use `effect@4.0.0`, so the browser bundle and the domain code share one copy.
- The workspace root uses `effect@4.0.6`, only for `alchemy.run.ts`.

This is safe because the infrastructure file does not import the domain package. If that changes, one of the two pins must move first. Re-check this whenever Foldkit or Alchemy is upgraded.

The API Worker in `apps/api` follows the same rule. It depends on `effect@4.0.0` and the domain package, like the web app. `alchemy.run.ts` only passes the path of its entry file to the Foldkit resource, and Vite bundles it from `apps/api`, so the bundle resolves `effect@4.0.0` and never meets the root copy. The same bundle answers `/api/health` under `alchemy dev` and under plain `workerd`.

## The root uses TypeScript 6, the packages use TypeScript 7

A transitive dependency of Alchemy (`capnp-es`) declares a peer on TypeScript 5.7 or 6. The root only typechecks one file, so it stays on 6. The packages use 7, as the Foldkit scaffold does.

## One stack at the root

Following Alchemy's single stack layout, one `alchemy.run.ts` deploys everything. Per package stacks can come later if the web app and a future API need separate deploy cadences.

## Domain first, as pure code

The triage engine is a pure function over validated data. It has no clock, no randomness and no I/O, so the same code can run in the browser today and in a Worker or Durable Object later. The simulated clock in the UI is part of the Model for the same reason.

## Synthetic data only

The seed cases are invented and carry no personal data, so the repository can be shared without exposing anything sensitive.

## The design follows MSF's official branding guidelines

Colours, text colours and typography follow the guidelines published by MSF Barcelona-Athens at branding-guidelines.msf.es: white as the main colour, red `#D7211E`, black, and `#414141` for web text. An earlier version used values read from msf.ch (`#EE0000`, `#292929` and a navy), which do not match the guidelines and were replaced.

The typeface, Atlas Grotesk, is licensed and not bundled. The guidelines reserve it for external communications and name Arial for other materials, so the font stack uses Atlas first, then the bundled open-licence Hanken Grotesk, then Arial, until MSF decides.

The footer shows the positive logo in Catalan, and the app uses the organisation's Catalan name, Metges Sense Fronteres. All branding lives in `src/brand.ts` and `src/styles.css`, so another centre can change it in one place. Use of the MSF name and logo is being confirmed with MSF.

## Operational centre is part of the case from the start

Making it a platform for the whole movement is much cheaper if every case carries its operational centre from the first version. Rules are not yet per centre, but the shape of the model already allows it.

## One shared D1 database on the free plan

All deployed versions use one D1 database. The Workers Free plan allows it without a payment card, and the limits are far above what a team prototype needs (checked in Cloudflare's documentation on 2 Nov 2026):

| Limit | Workers Free |
| --- | --- |
| Databases per account | 10 |
| Size of one database | 500 MB |
| Storage per account | 5 GB |
| Rows read per day | 5 million |
| Rows written per day | 100,000 |
| Queries per Worker request | 50 |
| Point-in-time recovery (Time Travel) | 7 days |
| Worker requests per day, whole account | 100,000 |
| CPU time per request | 10 ms |

When a daily limit is reached, queries or requests fail until 00:00 UTC. Nothing is charged. The 10 ms CPU limit is why password hashing uses PBKDF2 from Web Crypto, which runs natively, with an iteration count that fits inside one request.

## Frozen iterations are built from their git tag

Each delivered iteration keeps its own address (`iter1`, `iter2`, ...). `pnpm snapshots:prepare` extracts each tag into `.snapshots/<tag>` (git-ignored) and installs its dependencies there, and `alchemy.run.ts` builds the snapshot Workers from those folders. Later commits therefore never change what a snapshot serves. Only `app`, built from the working tree, owns the database migrations.

## One Worker per version, the API built per request

Each version is one Worker: static assets for the web app, and `/api/*` for the API, so the browser talks to its own origin and a plain `HttpOnly` cookie is enough. The RPC server is built for each request and disposed after it. Workers do not allow one request's I/O to run inside fibers started by another request, and a shared server hung on the second request.

## Sign-in with sessions in the shared database

Passwords are hashed with PBKDF2-SHA256 from Web Crypto, 100,000 iterations (the most Workers allow), in the format `pbkdf2-sha256$<iterations>$<salt>$<hash>`. The format and a frozen test vector must stay valid in every later version, because all versions share the accounts. Sessions store only the SHA-256 of a random token; the cookie is `HttpOnly`, `Secure`, `SameSite=Strict` and limited to `/api`, and sign-in only accepts a JSON body.

There is no sign-up page. `pnpm users:add` writes password hashes to `.local/users.sql`, which is git-ignored and imported into D1 after the migrations on each deploy (and into the local database by `pnpm infra:dev`). Roles stay in increment 3.

## Plain Commands instead of KeyedQuery

The web app loads and saves through ordinary Foldkit Commands that call the Effect RPC client. Foldkit's `KeyedQuery` is still experimental, and the desk loads one list of cases and one of rule sets, so caching by key adds nothing yet.
