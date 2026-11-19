# Decisions

## Product decisions

D1 to D24 are the product decisions behind Quoroom (D8 and D9 were about the course schedule and how commits were kept, and are left out). The sections after this table record the technical decisions and the measurements behind them.

| # | Question | Answer |
| --- | --- | --- |
| D1 | Plan | **Workers Free.** |
| D2 | Co-authoring | **No live co-editing.** Private autosaved working copies, shared drafts, a comparison item by item when two drafts collide, and "who is drafting" shown to the other authors |
| D3 | Rich text and images | **Rich text as in an email editor**, stored as structured JSON (a constrained ProseMirror schema), never as HTML. Built on Tiptap (MIT, on ProseMirror) with its standard extensions, not our own editor: headings inside a section, bold, italic, underline, bulleted and numbered lists, links, tables with added and removed rows and columns and adjustable widths, and images with a caption. **Images:** resized in the browser to at most 1600 px on the longest side and re-encoded as JPEG or PNG, which also drops their metadata; at most 1 MB each and 20 MB per report. Each image is withheld from redacted views, shown as "Image withheld", until an author marks it safe to share for that draft; its caption is redacted like any text. No evidence files outside rich text |
| D4 | PDFs | **Never stored.** A PDF is generated when someone asks, from one draft or revision, in that person's browser: original content for the drafting role, the stored redacted content for redacted roles. One pure renderer in `packages/domain` (document description) plus a PDF library with no DOM, which also runs in Node for the tests and the pilot script. It applies the theme (logo, fonts, colours, header and footer text). "Download all" renders each version and builds a zip in the browser. Approvals are not inside the content PDF: a separate **approval record** PDF (who decided what on which revision, when) is generated the same way. An old version rendered later looks like the current theme and renderer, which is accepted: the content itself never changes |
| D5 | Images | D1, base64 text in chunks below 1 MB per row, behind `ImageStore`. An image belongs to a report or to the theme. The Worker returns the stored text and the browser decodes it, so serving an image costs little CPU. **Reading an image** is allowed only if it is referenced by a draft or revision the caller may read and, for a `redacted` role, only if it is marked safe in that version: one query. The 20 MB per report counts referenced images. An image no shared draft has ever referenced may be deleted, the only exception to "nothing is deleted". Workers Free allows 500 MB per database, so the 20 MB limit allows about 18 full reports per environment, and far more at typical sizes. Uploads stop at 400 MB. Binary columns would save a third, but the SQL seam and its three adapters stay text and numbers only, which is simpler |
| D6 | Approval | The template sets the approval rule of each voting role: **all voters** (default, and the ethics unit's rule), **at least N**, or **a majority**. A round meets its rule only when every voting role meets its own. Publishing is refused if a rule cannot be met (N above the number of voters, or a voting role with no voters). Removing a reviewer recomputes the rule and is logged. Only the **latest revision** counts. A reviewer can send a new review while the round is open. *Comment only* is not a decision. Open comments do not block approval. Reviews on a superseded or decided round are refused. Members of the drafting role are never reviewers of the same report. An author can remove a reviewer from an open round (logged), but not one who has a standing decision (approve or request changes) on it: those stay in the round, and a silent one (or one who only commented) can be removed; the removed reviewer gets a notification ("removed from the round"). In-app approval does not replace a template's "prepared by" lines, which stay part of the content |
| D7 | Data | Internal testing uses invented data. In the pilot, the unit enters real reports into a pilot environment we host, accepting that whoever runs it can read it. The repository stays synthetic only: no pilot data in code, tests, fixtures, logs or screenshots, and nobody copies the pilot database to a laptop. Safeguards, each with a test: server-side authorization and redaction, no report text in logs, sign-in throttling, tokens only in POST bodies and `Referrer-Policy: no-referrer`, EU jurisdiction, and as few people as possible with access to the Cloudflare account |
| D10 | Names | **Draft 0** (empty), **Draft 1, 2 …** (shared among authors), **Revision 1, 2 …** (published to the committee; each records the draft it came from). A closing revision is numbered like any other and marked *closing*. Working copies have no number. PDFs: `<case reference>_<template short name>_Revision-2_redacted.pdf`, `<case reference>_<…>_Draft-5.pdf`. File names use the case file's reference, never its title |
| D11 | Drafting during review | Allowed. Reviewers only see revisions. Publishing Revision 2 closes the Revision 1 round: its reminders stop and its reviews stay in the grid as history |
| D12 | Reminders | Defaults, to reviewers who have not decided: on publish, then 48 h and 4 h before the deadline. At the deadline the round is decided (D18) and the authors are told the outcome; nobody is reminded after it. Deadlines are stored in UTC with the author's time zone and shown in the reader's. Quiet hours (21:00–08:00 Europe/Madrid) apply to channels outside the app only. The offsets, quiet hours and cron cadence are configuration of the stack, so test environments run with offsets of minutes and a cron every minute. Publishing writes the request, the two reminder jobs and the deadline job in its batch. Deduplication key: `(round, recipient, kind, deadline)`. Extending a deadline writes the new jobs in its batch, and the old ones fail the recheck |
| D13 | Accounts | No password is ever chosen by someone else or printed. Invitations, password resets and the first administrator of an environment are one-time links (72 h, stored as a hash, consumed atomically together with setting the password). A reset ends all of that person's sessions. Issuing and using a link are logged, and each account shows when its password was last set, so an author cannot quietly act as a reviewer. Accounts created by invitation have an unusable password hash until activated, which the frozen `iter2` sign-in already rejects.<br>**Existing email.** Since Quoroom sends no email, the person who invites someone receives the link. An invitation for an email that already has an account therefore never carries a password link. It only adds the role, grant or committee membership, and it is logged.<br>**Resets** are issued only by `pnpm grant-admin --reset` or by an administrator in the app.<br>**Links** carry the token in the URL fragment (`#…`); the page POSTs it, so it never appears in a request URL or a log.<br>**Throttling.** After 5 failures for one email within 15 minutes, or 20 from one IP, every attempt is refused, even with the right password, until a delay has passed. The delay doubles each time, up to 15 minutes. It never becomes a permanent lock |
| D14 | Redaction | The server replaces every alias in every text a redacted role can receive: rich text, structured fields, item and subsection titles, *not applicable* reasons, branch outcomes, the conclusion, link targets, table cells, image captions, the case file title as it was at sharing time, author replies to comments, file names and PDF metadata. The redaction path never runs for `full` roles, which read the original. Comment anchors stay on the revision they were made on; they are not carried to later revisions. Matching is case- and accent-insensitive, on whole words with Unicode-aware boundaries (so possessives work), longest alias first. The result is stored with the shared draft. Images not marked safe are left out of the redacted content altogether, so the server never hands them to a redacted role. Author replies are redacted when stored, against that revision's people list, and both versions are kept. Reviewers' comments are written on redacted text and stored as written. A comment from a `full` role shared with the whole committee is redacted when stored, like a reply, and redacted readers see that version on its section with the quoted text redacted, not as a highlight in their text. Comment anchors are positions in the redacted text, and authors see them in the redacted view of that revision. Name suggestions are a heuristic, only shown to authors. The author confirms the highlighted preview before publishing; replacement helps but cannot guarantee anonymity |
| D15 | Case files | A report belongs to a case file (reference, unit, title). New table, not the triage `cases` table. The label of the reference ("Integrity Line reference") is part of the template |
| D16 | Language and fonts | English interface. The theme picks the fonts from a bundled set of open fonts (Hanken Grotesk, Inter, Source Serif 4, Noto Sans), covering Latin, Greek and Cyrillic, checked for size. Right-to-left scripts and scripts that need shaping (Arabic, Amharic) are out of scope for PDFs: the PDF libraries cannot shape them. Names in those scripts appear correctly in the app; a PDF shows a clear placeholder and the docs say so |
| D17 | Reaching reviewers | **The in-app inbox receives every notification automatically**, shown on Home with an unread count. Nothing is sent outside the app, and My account and Home say so. E-mail, WhatsApp and other channels are integrations left to each deployment (see *Notifications outside the app*) |
| D18 | Closing | Report states and transitions, as a tested table in `packages/domain`:<ul><li>`drafting` → `in_review` when a revision is published.</li><li>`in_review` → `decided` when the open round meets its rule or reaches its deadline, whichever comes first; the round then accepts no reviews. The deadline can be extended only while the round is open.</li><li>`decided` → `in_review` when the authors publish another revision.</li><li>`decided` → `archived` when the round met its rule and the template has no conclusion.</li><li>`decided` → `concluding` when the authors start the conclusion (only if the template has one). In `concluding`, only the conclusion section can be saved (a server rule on the working copy), and only closing revisions can be published.</li><li>`concluding` → `archived` when a closing round meets its rule. A closing round decided by its deadline without the rule met leaves the report `concluding`, for another closing revision.</li></ul>Two rows the list implies, made explicit in the table: `in_review` → `in_review` when a new revision replaces the open round (D11), and `concluding` → `concluding` when a closing revision is published (a closing round stays `concluding` while open or decided by its deadline). A report archived by its rule goes through `decided` in one step. Drafting continues in every state but `archived`. At the deadline, the committee's votes are the outcome |
| D19 | Author notification preferences | Reviews with comments, change requests and "round decided": always on. Each single approval: off by default, switchable per author |
| D20 | Demo and pilot | No runtime mode. The latest code is Quoroom only in every environment; the triage desk runs only in the frozen `iter1` and `iter2`. Demo and pilot differ in what the stack deploys and imports (the demo database also holds the `iter2` accounts and synthetic cases). The legacy triage routes answer 404 in `app` and the pilot. One web build for both. Details in *Demo and pilot* below |
| D21 | First administrator of an environment | `pnpm grant-admin --env <environment> --email … --name …` (a Cloudflare stage such as `pilot`, `test-<n>`, `openorange`, `workerd` or `demo`) (and `--reset`) prints the activation link once. The account gets People, Theme and Templates. Reports is a capability per unit, so they give it to themselves after creating the first unit. The command appends to a per-environment file under `.local/` that every host imports (`importFiles` in `infra/quoroom.ts`; for `workerd`, the file is embedded in the build). Then that environment is deployed or restarted. Alchemy re-imports the whole file whenever it changes, so every statement is idempotent: the account with `INSERT … ON CONFLICT (email) DO NOTHING`, and the grants and invitation looking up the account by email. Demo and test environments use invented people. The real pilot's first administrator is created the same way, with that person's own name and e-mail |
| D22 | Deploys | **Routine:** `app` and `Database` updates on the demo stack; an `Iter2` update only if `alchemy plan` shows no replacement or deletion and the smoke check passes on `iter2` afterwards; creating and updating the `pilot` stack; `test_*` stacks. **Needs the owner's explicit agreement:** any replacement or deletion of a live resource, `iter1`, the alerts stack, the state store |
| D23 | Templates and roles | A template version is pure data, validated by a schema in `packages/domain`. It has:<ul><li>sections and subsections with stable IDs and instruction text (guidance only, never stored in content). Numbering is set per level: arabic, roman or letters, in upper or lower case, with a suffix (`.` or `)`), or none for unnumbered sections. A subsection can be repeatable: each repeat is a titled subsection with its own number, in the contents, and holds fixed items or subsections (an allegation with its facts and findings). Sections can be marked *front matter* (cover, contents, executive summary);</li><li>items: text; date, with day or month precision; select, with one or several answers, each option having a label (and an optional code such as A to F); people reference, one or several; rich text; a read-only case-file value (reference, unit or title); a signature block (a name and a date, printed with a signature line in PDFs; Quoroom captures no signature); and repeated entries that contain items (nested), shown with a numbered label such as "Allegation 1";</li><li>required, optional, or optional with a *not applicable* reason;</li><li>simple branching: one or more select items can each have an answer that ends the report early, as the intake's jurisdiction questions do, and the report ends if any of them has such an answer. Choosing it marks the later required sections *not applicable (ended)*, except those the template lists as staying in force (a sign-off, for example), which keeps numbering stable, and shows a fixed outcome text as a read-only item. Changing the answer back restores the sections with whatever they held. The report is still published and reviewed normally. The answer is an ordinary item in the comparison;</li><li>a cover, made of title lines that are fixed text or the value of an item or case-file field; an optional table of contents to a chosen depth; page numbering that restarts at 1 after the front matter; and header and footer text with `{page}`, `{pages}`, `{case}` and `{title}`, optionally different on the cover page. The template's text overrides the theme's default (D24);</li><li>**roles**: exactly one drafting role, which always has full view, editing, sharing, publishing and managing people (validation refuses a template without them), and one or more reviewing roles. Each reviewing role has a view (`full` or `redacted`), may comment or not, may vote or not, and, if it votes, an approval rule (D6);</li><li>optionally a **conclusion section**, empty and hidden in every revision until the report is `concluding` (D18), written by the drafting role, redacted like any section, and an ordinary item in the comparison.</li></ul>**Choosing people.** When a revision is published, an author fills each reviewing role from a committee of the report's unit or with individual accounts. The publish dialog shows each role with its view, so a `full` role is never chosen unknowingly. A person holds at most one reviewing role in a round and never a reviewing role in a report they author. The participants are frozen in the round. Templates are created and edited only by template editors. Editing creates a draft version of the template; publishing it makes it available for new reports. A template in use can be retired, but never deleted or changed. Publishing a template version is logged with its editor and its differences from the previous version. The two ethics templates ship as built-in data, imported into every environment only if absent (by stable ID and version), so a redeploy never changes or revives one. They can be copied. The details can be tuned with the first users |
| D24 | Theme | One theme per deployment, set by an administrator: organisation name, logo (an uploaded image), primary and accent colours, a font for headings and one for text from the bundled set (D16), and the PDF header and footer text (for example "STRICTLY CONFIDENTIAL"). Shipped default: a neutral Quoroom theme, with no MSF material in the repository. The app checks colour contrast and refuses a theme whose text would be unreadable. Applied to the app and to PDFs |

## Two Effect versions on purpose

Foldkit 0.169 pins `effect` to exactly 4.0.0 in its peer dependencies. Alchemy 2.0.0-beta.84 requires `effect` 4.0.5 or later. They cannot share one version.

The repository therefore uses two:

- `apps/web`, `apps/api`, `packages/domain` and `packages/pdf` use `effect@4.0.0`, so the browser bundle, the Worker and the domain code share one copy.
- The workspace root uses `effect@4.0.6`, only for the Alchemy stack files in `infra/`.

This is safe because nothing in `infra/` imports the app's code. The stacks only pass the path of the Worker's entry file to the Foldkit resource, and Vite bundles it from `apps/api`, so the bundle resolves `effect@4.0.0` and never meets the root copy. If that changes, one of the two pins must move first. Re-check this whenever Foldkit or Alchemy is upgraded.

## The root uses TypeScript 6, the packages use TypeScript 7

A transitive dependency of Alchemy (`capnp-es`) declares a peer on TypeScript 5.7 or 6. The root only typechecks `infra/`, so it stays on 6. The packages use 7, as the Foldkit scaffold does.

## One description of a deployment, three hosts

`infra/quoroom.ts` says what every deployment is: the Worker's entry, the web app's assets, the migrations, the imports of each environment, the API routes, the notification cron and its timings. It is plain data and paths, with no import of the app's code. Each host reads it:

- **Cloudflare**, with Alchemy: `infra/cloudflare.run.ts` (stack `Quoroom`), one Worker and its EU database per stage, driven by `infra/cloudflare.mjs`.
- **OpenOrange**: `infra/openorange.ts` writes a Wrangler configuration from it and runs the pinned `open-orange` CLI with `pnpm dlx`. Alchemy has no OpenOrange provider, and OpenOrange reads Wrangler configurations, so a generated file keeps one source without a second infrastructure tool. OpenOrange is not a dependency of the repository. Its database is a Rivet Actor on the Worker's nodes, reachable only once a node is up, and with OpenOrange 1.0.3 a remote database command stops the Cron Trigger until the nodes start again. So `deploy` never touches the database: a first deployment is deploy, `pnpm openorange database`, deploy again; a later one is `database`, then deploy ([`hosting.md`](hosting.md)).
- **workerd**: `apps/api/scripts/build-workerd.mjs` embeds the same migrations and imports in the bundle; `infra/workerd.sh` starts it.

The course's demo stack (`infra/demo.run.ts`, stack `TriageDesk`, stage `live_<user>`: `app`, the frozen `iter1` and `iter2`, and their shared database) and the error alert (`infra/alerts.run.ts`) are separate Alchemy stacks. Deploying or destroying one never touches the others. Stack names and resource IDs (`TriageDesk`, `Web`, `Pilot`, ...) date from earlier iterations and stay as they are: renaming one would replace what it deployed.

## Domain first, as pure code

`packages/domain` (templates, permissions, approval rules, comparison, redaction, numbering, the API contract) is pure code over validated data. It has no clock, no randomness and no I/O, so the same code runs in the browser and in the Worker. The triage engine of iterations 1 and 2 lives only in their tags.

## Synthetic data only

The seed data (the built-in templates, and the triage cases imported for the frozen `iter2`) is invented and carries no personal data, so the repository can be shared without exposing anything sensitive.

## The default look follows MSF's branding guidelines

Colours, text colours and typography follow the guidelines published by MSF Barcelona-Athens at branding-guidelines.msf.es: white as the main colour, red `#D7211E`, black, and `#414141` for web text. The typeface, Atlas Grotesk, is licensed and not bundled; the font stack uses Atlas first, then the bundled Hanken Grotesk, then Arial. Each deployment sets its own theme in the app (D24); no MSF logo is kept in the repository.

## One shared D1 database on the free plan

All demo versions use one D1 database; the pilot has its own. The Workers Free plan allows it without a payment card (checked in Cloudflare's documentation on 2 Nov 2026):

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
| Cron Triggers per account | 5 |

When a daily limit is reached, queries or requests fail until 00:00 UTC. Nothing is charged. The 10 ms CPU limit is why password hashing uses PBKDF2 from Web Crypto, which runs natively, and why nothing larger than one section crosses the Worker in one request (see *Logs and CPU*).

## Frozen iterations are built from their git tag

Each delivered iteration keeps its own address (`iter1`, `iter2`, ...). `pnpm snapshots:prepare` extracts each tag into `.snapshots/<tag>` (git-ignored) and installs its dependencies there, and `infra/demo.run.ts` builds the snapshot Workers from those folders. Later commits therefore never change what a snapshot serves. Only `app`, built from the working tree, owns the database migrations. The rules that keep the snapshots working are in [`architecture.md`](architecture.md).

## One Worker per version, the API built per request

Each version is one Worker: static assets for the web app, and `/api/*` for the API, so the browser talks to its own origin and a plain `HttpOnly` cookie is enough. The RPC server is built for each request and disposed after it: Workers do not allow one request's I/O to run inside fibers started by another request, and a shared server hung on the second request. `makeApp` builds only the handler the route needs, and the repository and service layers (which hold no request state) are kept per isolate.

## Sign-in and sessions in the shared database

Passwords are hashed with PBKDF2-SHA256 from Web Crypto, 100,000 iterations (the most Workers allow), in the format `pbkdf2-sha256$<iterations>$<salt>$<hash>`. Sessions store only the SHA-256 of a random 32-byte hex token; the cookie `case_desk_session` is `HttpOnly`, `Secure`, `SameSite=Strict` and limited to `/api`. The frozen `iter2` reads the same `users` and `sessions` rows, so these formats and a frozen test vector must stay valid in every later version.

There is no sign-up page. Accounts come from invitations and one-time links (D13), and the first account of an environment from `pnpm grant-admin` (D21), with People, Theme and Templates. On the demo only, `pnpm users:add` writes password hashes to `.local/users.sql` (git-ignored), imported after the migrations on each deploy, for accounts shared with `iter2`.

## Permissions: one capability, one tab

- **Four capabilities**, each a top tab shown only to whoever holds it: People (accounts, units, grants, activation and reset links), Theme, Templates, and Reports in a unit. Home is for everyone and holds the inbox and the notifications; `/inbox` and `/notifications` open it. A reviewer is not a capability and sees only Home. The account page is reached from the person's name in the header.
- **Somebody keeps People.** `leavesNobodyForPeople` (domain, unit-tested) refuses a revocation that leaves no active account with People; `RevokeCapability` answers with a validation message.
- **Migration 0010.** `capability_grants` has a `CHECK` naming `admin`, and SQLite cannot change a CHECK, so the grants move to a new table, `permission_grants`, with no value list. Each `admin` grant becomes `people` and `theme`; `template_editor` and `author` are copied; the old `operator` actions are gone. The old table stays, unused (expand-only); unknown names are ignored when grants are read. A grant file made by an older `grant-admin` and not yet imported writes to the old table, so make it again.

## Demo and pilot run the same code (D20)

The latest code is Quoroom only and has no runtime mode: `app`, the pilot, OpenOrange and `workerd` serve the same Worker. The triage desk runs only in the frozen `iter1` and `iter2`, which have their own Worker and API; `/api/login`, `/api/logout`, `/api/session` and `/api/rpc` answer 404 in the latest code. Demo and pilot differ only in what is deployed and imported (`importFiles` in `infra/quoroom.ts`):

- **Demo database:** the migrations, the built-in templates, `.local/users.sql`, `.local/grants-demo.sql` and `apps/api/seed/demo-cases.sql` (for `iter2`).
- **Any other deployment** (a Cloudflare stage, OpenOrange, `workerd --mode pilot`): the migrations, the built-in templates and `.local/grants-<environment>.sql`. On Cloudflare its own D1 has `jurisdiction: "eu"`; never change the jurisdiction after the first deploy: it replaces the database.
- **workerd:** `pnpm workerd --mode demo|pilot` chooses the embedded imports (demo adds `users.sql`; neither embeds the triage cases) and the data folder.

The built-in templates (`apps/api/seed/builtin-templates.sql`) are insert-if-absent, generated from the domain by `pnpm --filter @quoroom/api templates:sql` and kept in sync by a test.

## The Cloudflare stack and the test environments

- **Stages.** A stage of letters and digits is a deployment with a Worker of the same name (`quoroom` by default; `pilot` is the MSF pilot), and `test_<name>` a throwaway one with the Worker `quoroom-test-<name>`. The file throws for any other stage, including the demo stack's `ALCHEMY_STAGE=live_<user>` in `.env`. The stack was first the pilot's alone, so its Worker's resource ID is still `Pilot`.
- **Commands.** `pnpm cloudflare:plan|deploy|destroy [stage]` always pass the stage explicitly. `pnpm test-env:up <test_name> [--fast] [--invocation-logs]` deploys with `--yes` and prints the URL; `pnpm test-env:down <test_name>` destroys it and removes its grants file. `--fast` sets reminders 10 and 3 minutes before the deadline instead of 48 h and 4 h. Other stages ignore both flags.
- **Guards.** `infra/cloudflare.mjs` passes only `--yes`, `-y`, `--dry-run` and `--detailed` to alchemy, always passes `--profile default`, and refuses to run when `ALCHEMY_PROFILE`, `CLOUDFLARE_ACCOUNT_ID` or another account-selecting variable (`infra/guards.mjs`) is set to anything but the default. The message names the variable, never its value.
- **First-admin imports apply once.** Each generated grant file carries a unique import ID recorded in `applied_imports`; its statements run only when the ID is absent, so a re-run on every deploy or workerd start cannot undo a revocation.
- **Observability.** Workers Logs on, invocation logs off (they record the URL and headers), traces off, Issues on. The code logs errors without content and the counts of each notification pass, never a request body. A test stage can turn invocation logs on for CPU measurements; a test checks the stack file.
- **Referrer-Policy on static assets.** On Cloudflare, `apps/web/public/_headers` sets `Referrer-Policy: no-referrer`, because assets bypass the Worker (`runWorkerFirst: ["/api/*"]`). A test checks the built `dist/_headers`. OpenOrange does not apply `_headers`, so there the Worker answers every request (`run_worker_first: true`) and adds the header itself, as it does on `workerd`.
- **`/api/config` is public and minimal:** the theme's colours, fonts, organisation name and a reference to the logo. Everything else needs a session.

## Plain Commands instead of KeyedQuery

The web app loads and saves through ordinary Foldkit Commands that call the Effect RPC client. Foldkit's `KeyedQuery` is still experimental, and each screen loads its own data, so caching by key adds nothing. Every Command carries a page scope (report, entry generation, reload epoch), and an answer for another scope is dropped (`apps/web/src/quoroom/scope.ts`).

## A session that ends, and Escape

A signed-in call answered `Unauthorised` announces `quoroom-session-ended` on the window. The app shows the sign-in at the same address and keeps every screen's Model; the same account signing in again resumes (unsaved edits are saved at once), a different account starts from empty screens, so nothing of one account is shown to another. Escape answers an open in-page question with "no", the question takes the focus when it opens, and the focus returns to what opened it.

## The rich-text editor

- **Tiptap 3.33.1, pinned exactly, single extensions** (`@tiptap/core`, `@tiptap/pm`, `extension-document`, `-paragraph`, `-text`, `-heading`, `-bold`, `-italic`, `-underline`, `-link`, `-list`, `-table`, and `@tiptap/extensions` for `UndoRedo` and `Gapcursor`). All MIT, none touches Tiptap's cloud or depends on `effect`. Images are our own `figure` node, not `@tiptap/extension-image`. Chosen after a spike (12 Nov) that passed at 375 px: no cursor jump on echo, tables and column widths, undo, selection events, and an exact JSON round trip.
- **A custom element** (`apps/web/src/quoroom/editor/element.ts`), plain DOM code in the light DOM that draws its own toolbar. Foldkit sets the `content` and `version` properties and listens to `change` and `selection` events. The element keeps `knownVersion`: a local edit increments it and emits `change` (debounced 250 ms, at most 1 s); an incoming version is applied only if it is greater, so the echo of its own change never touches the document or the caret. The toolbar's logic is pure and unit tested (`toolbar.ts`).
- **Schema.** `extensions.ts` is exactly the domain schema (headings 1 to 4, no hard break, links `http`, `https`, `mailto`, `tel`, the `figure` node). Every change is decoded with `decodeRichText` and made canonical, so the Model and the save only ever hold canonical JSON. A refused change shows a notice and is not saved.
- **Tiptap bug worked around.** After undo of a column resize, `TableView` leaves the old `width` on the `<col>`; `ClearingTableView` clears it.
- **Lazy loading.** `LoadEditor` imports the element when a section the author may edit is first shown. Read-only views use `richTextView.ts` and never load Tiptap. The chunk is about 433 KB raw, 135 KB gzip; the browser test asserts it is not requested early and stays under 250 KB gzip.
- **Known limits.** Column resizing by touch is not possible (ProseMirror's resize plugin has no touch drag; widths can be set with buttons). A link title is not editable.

## PDFs and downloads

- **Libraries, pinned exactly.** `pdfmake` 0.3.14 (`packages/pdf` and `apps/web`); `pdfjs-dist` 6.5.438 (dev only, to read PDFs back in tests); `esbuild` 0.28.2 (dev only, bundles the Node runner and the workerd build). Fonts: the static `.woff` files of `@fontsource/hanken-grotesk`, `inter`, `noto-sans` (5.3.0) and `source-serif-4` (5.3.1), under the SIL Open Font License; fontkit cannot read `.woff2` or variable fonts. `pdf-lib` was rejected: no layout engine for tables, wrapping or contents. Chosen after a spike (12 Nov): a 20-page report rendered in about 2 s in a phone-sized browser with 4x CPU throttling, with identical text in Node and the browser.
- **Where the code is.** `packages/domain` only describes the document (`documentDescription`, `approvalRecordDescription`, `pdfFileName`). `packages/pdf` maps that to a pdfmake definition (`definition.ts`, no DOM, no Node API) with two adapters: `node.ts` (tests and `node packages/pdf/scripts/render.mjs job.json out.pdf`) and `browser.ts`. `apps/web` loads the browser adapter in one lazy chunk (about 290 KB gzip) only when someone asks for a PDF; pdfmake's URL and local access policies refuse everything.
- **Per-script fonts (D16).** Every text is split into runs by script from the fontsource `unicode-range` tables, in NFC, and each run gets the font file of its subset. A run no subset covers (Arabic, Amharic, Chinese, symbols) prints as `[?]`; common symbols are first mapped to what the fonts have. A test checks with fontkit that every family, script and face has a glyph for its range.
- **Contents and page numbers.** pdfmake's own contents prints only global page numbers, so the contents is drawn by us and a document with contents is rendered twice: the first pass learns the page of each heading. Header and footer text take `{page}`, `{pages}` and the other tokens, a different one on the cover, and roman numerals for the front matter.
- **Zip: our own store-only writer** (`zip.ts`, about 100 lines): PDFs are already compressed. UTF-8 names, CRC-32, a fixed time stamp for byte-identical output, no zip64. "Download all" renders one file at a time, keeps images already read, and refuses above 1.5 GB or 60,000 entries.
- **What a person may download.** Authors: every shared draft and revision in both views, and the approval record once a round is decided. A redacted reviewer gets one button, and the server picks the view. A redacted PDF is built from content the server already redacted; a withheld figure is never fetched (a test searches the PDF bytes). The date on a PDF is the day the version was shared or published, so the same version prints the same twice.
- **PDF colours** are derived from the theme so that text keeps 4.5:1 contrast for every theme `themeProblems` accepts (property test).

## The theme

- **The logo is served behind the session.** It is an image owned by the theme (uploaded by whoever holds Theme, readable by any signed-in account). `/api/config` is public and cached for 30 s and carries only a reference to the logo, so the sign-in screen shows the name and colours but no logo. There is no second public image path to keep safe.
- **Saving.** `UpdateTheme` refuses unreadable contrast, unknown tokens and an incomplete or foreign logo; the screen checks the same `validateTheme` while typing. Saving applies the theme without a reload; a fresh load may see the old public config for up to 30 s. A replaced logo is removed by the notification pass's stale-image cleanup after a day.
- **Header and footer.** A template's own texts replace the theme's; the theme's apply where the template has none.

## Template drafts

A template draft has a revision counter: a save or a publish that did not see the latest one is a Conflict (`stale_save`) and the editor offers a reload. Retiring is sticky until `RestoreTemplate`. A broken draft is removed with `DiscardTemplateDraft`. Built-in templates take copies only. Published versions never change.

## The notification pass

- **State machine of a job** (`notification_jobs`): `pending` (due at `due_at`) -> `claimed` (until `lease_until`, by one pass) -> `done` | `skipped` | `failed`. A `failed` job with a `retry_at` is claimed again at that time. A claim whose lease has run out is claimed again, so a pass that stops halfway loses nothing. `attempts` counts real channel failures (at most `MAX_ATTEMPTS`, 5; back-off 1, 2, 4, 8 minutes, at most 15). `deferrals` counts lease takeovers and storage errors, with its own cap `MAX_DEFERRALS` (50), so a killed pass never fails a job for good. A job released unprocessed goes back to `pending` with its attempt given back.
- **No duplicates.** The claim is one `UPDATE ... WHERE id IN (SELECT ... ORDER BY due_at LIMIT ?) RETURNING`, and every write that finishes a job is guarded by `state = 'claimed' AND claimed_by = ?`. The in-app inbox item is the `done` job row itself.
- **Recheck.** Before sending, each job is checked with `isJobNeeded` against fresh state; not needed means `skipped`. The pass loads each report with the same `loadReport` the handlers use, which decides a round past its deadline and writes its `round_decided` jobs, delivered in the same pass.
- **Sizing for Workers Free.** At most 5 jobs per claim, 1 report per run, and 50 D1 queries per pass (the pass counts them and releases what it cannot reach). An idle run is one raw SQL query before any Effect layer; housekeeping (`cleanupStale`, pruning) runs only in the first minute of each hour.
- **Channel.** `NotificationChannel.send(message)` takes the message kind, the recipient, a link and an idempotency key, and returns `Sent` or `Failed {retryable}`. The in-app inbox is the only channel.
- **Starting the pass.** The Worker's `scheduled` handler (a Cron Trigger every minute on `app`, the pilot and test stages; errors logged, never rethrown) and `POST /api/tick` for hosts without cron (guarded by `TICK_SECRET` with a constant-time compare; 404 for every other request). The frozen Workers have no cron and no `TICK_SECRET`, so nothing is sent twice.
- **Timings** come from `NOTIFY_REQUEST_DELAY_MINUTES`, `NOTIFY_FIRST_REMINDER_MINUTES` and `NOTIFY_FINAL_REMINDER_MINUTES`, read once per isolate by handlers and the pass alike. Invalid values fall back to the defaults with a logged line.
- **Inbox.** `ListNotifications` carries no case reference, title or content, only generic lines, ids, times and the deadline with its zone. `GetUnreadCount` polls every 30 s, backs off to 5 min when nothing changes, and pauses while the tab is hidden.

## Notifications outside the app

Not built, on purpose. Notifications reach people only in the app, on Home; My account and Home say that Quoroom sends no e-mail or other messages. The WhatsApp links of earlier versions were removed on 16 Nov.

A channel outside the app (e-mail, WhatsApp, SMS, a chat tool) is an integration with an outside provider, not part of the core: it depends on that provider's account, cost and data-protection terms, and on the host, so it is left to whoever deploys Quoroom. The notification pass is ready for one ([`architecture.md`](architecture.md), "Notifications outside the app").

- **E-mail on Cloudflare.** Cloudflare Email Service: a `send_email` binding used by the notification pass, as a second `NotificationChannel`. It needs a domain on Cloudflare DNS (about $10/year). Workers Paid ($5/month) includes 3,000 e-mails a month, then $0.35 per 1,000. On Workers Free only addresses verified in the account can receive mail, so it cannot reach reviewers.
- **On OpenOrange or `workerd`.** There is no sending binding: a channel calls a provider's HTTP API (an e-mail service, or WhatsApp Business through Meta or a reseller), with its key as a secret of the deployment.
- **Content.** A message carries only a notice and a link, never report content.
- **Left in the DB.** The phone and consent columns (`account_profiles`, `unit_reviewers`) and the job's provider and delivery columns stay, since migrations are expand-only and the frozen `iter2` shares the database. The code no longer reads or writes them; their defaults fill new rows.

## Browsers for the end-to-end tests

`packages/e2e` drives a real browser with `playwright-core` 1.65.0 (no bundled browsers) and the system Chromium (`/usr/bin/chromium`, or `E2E_CHROMIUM`). It is a dev dependency of that package only and has no `test` script, so `pnpm check` needs no browser. It starts its own workerd on a free port with a temporary data folder: `pnpm --filter @quoroom/e2e e2e`.

The route sweep (`sweep.ts`) and the keyboard and session steps (`keyboard.ts`) also run in Firefox: `pnpm --filter @quoroom/e2e exec playwright-core install firefox` puts it in Playwright's cache. `E2E_ENGINES=chromium` runs Chromium only; `E2E_SKIP_SWEEP=1` skips the sweep. The route list comes from `AppRoute.members` in `apps/web/src/route.ts`, and a route without a sample in `sweep.ts` fails the type check.

WebKit cannot run on this machine (Arch Linux without `sudo`; its build needs older `libicu`, `libxml2`, `libjxl` and `libbacktrace`). It needs `sudo npx playwright install-deps` or a Debian/Ubuntu host, so Safari is not covered by a real engine.

## Logs and CPU

**Design rule from the CPU spike (12 Nov): nothing larger than one section crosses the Worker in one request.** Sharing a 20-page draft as one request cost 15 to 21 ms warm, mostly for moving 110 KB into and out of D1 and through the RPC body. Sharing is therefore a sequence driven by the browser: one `ShareSection` per section (the server reads the stored working copy, redacts it and stages it), then `FinishShare`, which builds the draft rows with `INSERT ... SELECT` and `json_group_array` so the Worker never holds the whole text. `FinishShare` is guarded on the number of staged sections. Other findings of the spike that the code relies on: image chunks use the native `Uint8Array.prototype.toBase64()` (the `btoa` fallback took 22 to 39 ms per 700 KB chunk); the redaction fold has an ASCII fast path (a per-character `normalize('NFD')` costs about four times more); all writes use `D1Database.batch` with guards; a cold first request of an isolate costs 19 to 54 ms and is not cut off.

**Log test (13 Nov, test environment `test_s10b`): pass.** One report driven through every step with invented marker strings in every field, comment, name and alias, plus refused requests and malformed RPC bodies. With the pilot's configuration none of the 34 markers was found in the Workers Logs, by the API's free-text search or by a scan of every event, while the pass summary was found (positive control). With invocation logs on, a marker in a request path was found and none of 322 markers in request bodies.

**CPU (13 Nov, test environment `test_s10c`): no request or run was cut off, but the target is not met.** The target from the spike was a warm p95 under 8 ms per procedure. After the changes above (only the needed handler built per request, per-isolate layers, batched reads such as `readReportParts` and `getDraftWithSections`, the ASCII fold), warm p50 / p95 in ms:

| Procedure | p50 / p95 |
| --- | --- |
| `GetRevisionSection`, `GetDraftSection`, `GetWorkingCopySection`, `SaveSection` | 3 to 5 / 6 to 9 |
| `GetRevisionOutline`, `AddComment`, `GetUnreadCount`, `ListInbox` | 3 to 5 / 5 to 10 |
| `ShareSection` | 7 / 13 to 15 |
| `FinishShare`, `SendReview`, `PublishRevision` | 7 to 9 / 8 to 13 |
| Sign-in (PBKDF2, recorded only) | 27 to 43 |
| Notification pass, busy (always a cold isolate under cron) | median 16, 12 to 46 |
| Notification pass, idle | 5 / 6 |

For a warm section read at 5 ms, about 0.7 ms is our own code, each of its 3 D1 round trips about 1 ms, and the rest fixed runtime work. Two runs differed by 1 to 2 ms on the same procedures, as much as the margin to the target. What could still reduce it: one round trip for session, membership and report together; a per-isolate session cache (refused: it would cache authorization); the paid plan. **Open for the user.**

**How to measure again.** On a test environment with invocation logs (they carry `cpuTimeMs`, `wallTimeMs` and `outcome` per request):

```sh
pnpm -s grant-admin --env test-<name> --email alma.ortega@example.org --name "Alma Ortega" \
  --origin https://quoroom-test-<name>.<subdomain>.workers.dev > /tmp/admin-link.txt
pnpm test-env:up test_<name> --fast --invocation-logs
pnpm rehearsal https://quoroom-test-<name>.<subdomain>.workers.dev --admin-link-file /tmp/admin-link.txt
node scripts/workers-logs.mjs events quoroom-test-<name> --from <start, ISO> --out /tmp/events.json
node scripts/workers-logs.mjs search quoroom-test-<name> --from <start, ISO> --markers <markers.json>
pnpm test-env:down test_<name>
```

`events` writes every event of the window to a file and prints only a count; `search` looks for each string of a JSON list (for the log test, invented text the run typed) and prints counts, never events. Both refuse any Worker not named `quoroom-test-*`. (The measurements above ran when test Workers were named `test-<name>-pilot`.) Events appear 30 to 60 s after the request. The local profiler that served `worker.ts` on Node's SQLite (`apps/api/scripts/cpu-bench.ts`) and the API-level driver (`live-run.ts`) were removed after the measurements; they are in the history before the slim-down (commit `269db95`).

## Open questions for the unit

- Which operational centres should the first pilot cover?
- What identifier format links a case to its Integrity Line record?
- Can the Integrity Line export cases or notify other systems, or is a case file always entered by hand?
