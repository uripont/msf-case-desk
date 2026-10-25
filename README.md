# Case Desk

A prototype for assessing and deciding cases in the ethics and behaviour teams of Metges Sense Fronteres (MSF), across all its operational centres. Built at Universitat Pompeu Fabra for the Project Management course (team 101_E), together with MSF's Ethics & Behaviour Unit.

**Live prototype:** https://uripont.github.io/msf-case-desk/

Today a case can wait up to two weeks for the next meeting before anyone assesses it. Case Desk shows what needs attention first and why, so a case can go from received to decided without waiting. It is an internal tool for the people who assess and decide cases. It complements MSF's Integrity Line, which takes reports from people, and does not replace it ([context](docs/context.md)).

> All cases are synthetic. No real case data is used or stored.

**Increment 1** is a client-side prototype of the home dashboard: a headline of what is overdue or due soon, a time axis of every open case, cases grouped as Urgent, Medium and Standard with the reasons behind each, a switch between operational centres, and a phone layout. A "Demo controls" toggle in the footer moves a simulated clock, to watch cases become overdue. There is no server, sign-in or saved data yet. The scoring rules are in [`docs/triage-rules.md`](docs/triage-rules.md).

## Stack

The project is built on the CAFE stack:

| Layer | Tool | Role here |
| --- | --- | --- |
| **C**loudflare | Workers and static assets | Where the backend will run |
| **A**lchemy | Infrastructure as Effects | The deployment is one typed program, [`alchemy.run.ts`](alchemy.run.ts) |
| **F**oldkit | Elm Architecture on Effect | The web app: one Model, fact-named Messages, an exhaustive `update` |
| **E**ffect | Schema, services, layers | The domain model and its validation |

Plus Vite 8, Tailwind 4, Vitest 5, fast-check, TypeScript 7, oxlint and oxfmt, with pnpm workspaces.

## Layout

```text
.
├── alchemy.run.ts          # the deployment stack (Cloudflare, via Alchemy)
├── apps/
│   └── web/                # Foldkit single-page app
└── packages/
    └── domain/             # pure triage domain: schemas, rules, scoring, queue
```

The domain package has no UI and no I/O. The scoring engine is a pure function from a case and a rule set to a result with reasons, so it is easy to test and it stays the same when the storage and the runtime change.

## Getting started

You need Node 24.11.1 or later and pnpm.

```sh
pnpm install
pnpm dev          # http://localhost:5173
```

| Script | What it does |
| --- | --- |
| `pnpm dev` | Runs the web app with live reload |
| `pnpm test` | Runs the domain and web tests |
| `pnpm typecheck` | Typechecks both packages and the infrastructure file |
| `pnpm lint` | Runs oxlint, including the Foldkit and Effect rules |
| `pnpm build` | Builds the production bundle |
| `pnpm check` | Runs all of the above, as CI does |

## Testing

- **Property tests** (fast-check) on the scoring engine: a fast-track signal always makes a case urgent, raising a factor never lowers the priority, scores stay in range, results are deterministic, and every result explains itself.
- **Story tests** (Foldkit) drive the `update` function with Messages and assert on the Model.
- **Scene tests** (Foldkit) render the real view and interact with it through accessible locators, with no browser.

## Deploying

The web app is published to GitHub Pages by [`.github/workflows/pages.yml`](.github/workflows/pages.yml) on every push to `main`.

The backend will run on Cloudflare in later increments. Its stack is declared in [`alchemy.run.ts`](alchemy.run.ts), typechecked but not deployed yet:

```sh
pnpm infra:plan      # preview changes
pnpm infra:deploy    # deploy
pnpm infra:destroy   # remove everything
```

Connect Cloudflare first with `pnpm exec alchemy profile edit --add Cloudflare`.

> [!NOTE]
> Alchemy v2 and Foldkit are both in beta. Versions are pinned exactly, and the reason for the two Effect versions in this repository is explained in [`docs/decisions.md`](docs/decisions.md).

## Design and branding

The interface follows [MSF's branding guidelines](https://branding-guidelines.msf.es/eng/): a white page, MSF red (`#D7211E`) to highlight, dark grey text, square corners and a heavy grotesque headline. Atlas Grotesk, MSF's typeface, is licensed and not included, so the font stack falls back to the open-licence Hanken Grotesk. The footer shows the positive logo, and all branding lives in [`apps/web/src/brand.ts`](apps/web/src/brand.ts) and [`apps/web/src/styles.css`](apps/web/src/styles.css).

## Roadmap

| Increment | Window | Scope |
| --- | --- | --- |
| 1 | until 25 Oct 2026 | Project setup, domain model, scoring engine, home dashboard |
| 2 | until 6 Nov 2026 | Case entry, editable rules per operational centre, saved data, backend on Cloudflare |
| 3 | until 20 Nov 2026 | Asynchronous votes and approvals, audit log, sign-in and roles, KPI view, simulation |
| Closure | until 29 Nov 2026 | Hardening, self-hosting guide, documentation, final demo |

## Licence

MIT. See [LICENSE](LICENSE).
