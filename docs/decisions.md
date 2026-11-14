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
| D7 | Data | Internal testing uses invented data. In the pilot, Sergio enters real reports into a pilot environment we host, accepting that whoever runs it can read it. The repository stays synthetic only: no pilot data in code, tests, fixtures, logs or screenshots, and nobody copies the pilot database to a laptop. Safeguards, each with a test: server-side authorization and redaction, no report text in logs, sign-in throttling, tokens only in POST bodies and `Referrer-Policy: no-referrer`, EU jurisdiction, and as few people as possible with access to the Cloudflare account |
| D10 | Names | **Draft 0** (empty), **Draft 1, 2 …** (shared among authors), **Revision 1, 2 …** (published to the committee; each records the draft it came from). A closing revision is numbered like any other and marked *closing*. Working copies have no number. PDFs: `<case reference>_<template short name>_Revision-2_redacted.pdf`, `<case reference>_<…>_Draft-5.pdf`. File names use the case file's reference, never its title |
| D11 | Drafting during review | Allowed. Reviewers only see revisions. Publishing Revision 2 closes the Revision 1 round: its reminders stop and its reviews stay in the grid as history |
| D12 | Reminders | Defaults, to reviewers who have not decided: on publish, then 48 h and 4 h before the deadline. At the deadline the round is decided (D18) and the authors are told the outcome; nobody is reminded after it. Deadlines are stored in UTC with the author's time zone and shown in the reader's. Quiet hours (21:00–08:00 Europe/Madrid) apply to channels outside the app only. The offsets, quiet hours and cron cadence are configuration of the stack, so test environments run with offsets of minutes and a cron every minute. Publishing writes the request, the two reminder jobs and the deadline job in its batch. Deduplication key: `(round, recipient, kind, deadline)`. Extending a deadline writes the new jobs in its batch, and the old ones fail the recheck |
| D13 | Accounts | No password is ever chosen by someone else or printed. Invitations, password resets and the first administrator of an environment are one-time links (72 h, stored as a hash, consumed atomically together with setting the password). A reset ends all of that person's sessions. Issuing and using a link are logged, and each account shows when its password was last set, so an author cannot quietly act as a reviewer. Accounts created by invitation have an unusable password hash until activated, which the frozen `iter2` sign-in already rejects.<br>**Existing email.** Since Quoroom sends no email, the person who invites someone receives the link. An invitation for an email that already has an account therefore never carries a password link. It only adds the role, grant or committee membership, and it is logged.<br>**Resets** are issued only by `pnpm grant-admin --reset` or by an administrator in the app.<br>**Links** carry the token in the URL fragment (`#…`); the page POSTs it, so it never appears in a request URL or a log.<br>**Throttling.** After 5 failures for one email within 15 minutes, or 20 from one IP, every attempt is refused, even with the right password, until a delay has passed. The delay doubles each time, up to 15 minutes. It never becomes a permanent lock |
| D14 | Redaction | The server replaces every alias in every text a redacted role can receive: rich text, structured fields, item and subsection titles, *not applicable* reasons, branch outcomes, the conclusion, link targets, table cells, image captions, the case file title as it was at sharing time, author replies to comments, file names and PDF metadata. The redaction path never runs for `full` roles, which read the original. Comment anchors stay on the revision they were made on; they are not carried to later revisions. Matching is case- and accent-insensitive, on whole words with Unicode-aware boundaries (so possessives work), longest alias first. The result is stored with the shared draft. Images not marked safe are left out of the redacted content altogether, so the server never hands them to a redacted role. Author replies are redacted when stored, against that revision's people list, and both versions are kept. Reviewers' comments are written on redacted text and stored as written. A comment from a `full` role shared with the whole committee is redacted when stored, like a reply, and redacted readers see that version on its section with the quoted text redacted, not as a highlight in their text. Comment anchors are positions in the redacted text, and authors see them in the redacted view of that revision. Name suggestions are a heuristic, only shown to authors. The author confirms the highlighted preview before publishing; replacement helps but cannot guarantee anonymity |
| D15 | Case files | A report belongs to a case file (reference, unit, title). New table, not the triage `cases` table. The label of the reference ("Integrity Line reference") is part of the template |
| D16 | Language and fonts | English interface. The theme picks the fonts from a bundled set of open fonts (Hanken Grotesk, Inter, Source Serif 4, Noto Sans), covering Latin, Greek and Cyrillic, checked for size. Right-to-left scripts and scripts that need shaping (Arabic, Amharic) are out of scope for PDFs: the PDF libraries cannot shape them. Names in those scripts appear correctly in the app; a PDF shows a clear placeholder and the docs say so |
| D17 | Reaching reviewers | **The in-app inbox receives every notification automatically**, shown on Home with an unread count. Nothing is sent outside the app; My account and Home say e-mail notifications are coming soon (see *External notifications*) |
| D18 | Closing | Report states and transitions, as a tested table in `packages/domain`:<ul><li>`drafting` → `in_review` when a revision is published.</li><li>`in_review` → `decided` when the open round meets its rule or reaches its deadline, whichever comes first; the round then accepts no reviews. The deadline can be extended only while the round is open.</li><li>`decided` → `in_review` when the authors publish another revision.</li><li>`decided` → `archived` when the round met its rule and the template has no conclusion.</li><li>`decided` → `concluding` when the authors start the conclusion (only if the template has one). In `concluding`, only the conclusion section can be saved (a server rule on the working copy), and only closing revisions can be published.</li><li>`concluding` → `archived` when a closing round meets its rule. A closing round decided by its deadline without the rule met leaves the report `concluding`, for another closing revision.</li></ul>Two rows the list implies, made explicit in the table: `in_review` → `in_review` when a new revision replaces the open round (D11), and `concluding` → `concluding` when a closing revision is published (a closing round stays `concluding` while open or decided by its deadline). A report archived by its rule goes through `decided` in one step. Drafting continues in every state but `archived`. At the deadline, the committee's votes are the outcome |
| D19 | Author notification preferences | Reviews with comments, change requests and "round decided": always on. Each single approval: off by default, switchable per author |
| D20 | Demo and pilot | No runtime mode. The latest code is Quoroom only in every environment; the triage desk runs only in the frozen `iter1` and `iter2`. Demo and pilot differ in what the stack deploys and imports (the demo database also holds the `iter2` accounts and synthetic cases). The legacy triage routes answer 404 in `app` and the pilot. One web build for both. Details in *Demo and pilot* below |
| D21 | First administrator of an environment | `pnpm grant-admin --env <demo|pilot|test-n|workerd> --email … --name …` (and `--reset`) prints the activation link once. The account gets People, Theme and Templates. Reports is a capability per unit, so they give it to themselves after creating the first unit. The command appends to a per-environment file under `.local/` that the stack lists in `importFiles` (for `workerd`, the file is embedded in the build). Then that stack is deployed. Alchemy re-imports the whole file whenever it changes, so every statement is idempotent: the account with `INSERT … ON CONFLICT (email) DO NOTHING`, and the grants and invitation looking up the account by email. Demo and test environments use invented people. The real pilot's first administrator is created the same way, with that person's own name and e-mail |
| D22 | Deploys | **Routine:** `app` and `Database` updates on the demo stack; an `Iter2` update only if `alchemy plan` shows no replacement or deletion and the smoke check passes on `iter2` afterwards; creating and updating the `pilot` stack; `test_*` stacks. **Needs the owner's explicit agreement:** any replacement or deletion of a live resource, `iter1`, the alerts stack, the state store |
| D23 | Templates and roles | A template version is pure data, validated by a schema in `packages/domain`. It has:<ul><li>sections and subsections with stable IDs and instruction text (guidance only, never stored in content). Numbering is set per level: arabic, roman or letters, in upper or lower case, with a suffix (`.` or `)`), or none for unnumbered sections. A subsection can be repeatable: each repeat is a titled subsection with its own number, in the contents, and holds fixed items or subsections (an allegation with its facts and findings). Sections can be marked *front matter* (cover, contents, executive summary);</li><li>items: text; date, with day or month precision; select, with one or several answers, each option having a label (and an optional code such as A to F); people reference, one or several; rich text; a read-only case-file value (reference, unit or title); a signature block (a name and a date, printed with a signature line in PDFs; Quoroom captures no signature); and repeated entries that contain items (nested), shown with a numbered label such as "Allegation 1";</li><li>required, optional, or optional with a *not applicable* reason;</li><li>simple branching: one or more select items can each have an answer that ends the report early, as the intake's jurisdiction questions do, and the report ends if any of them has such an answer. Choosing it marks the later required sections *not applicable (ended)*, except those the template lists as staying in force (a sign-off, for example), which keeps numbering stable, and shows a fixed outcome text as a read-only item. Changing the answer back restores the sections with whatever they held. The report is still published and reviewed normally. The answer is an ordinary item in the comparison;</li><li>a cover, made of title lines that are fixed text or the value of an item or case-file field; an optional table of contents to a chosen depth; page numbering that restarts at 1 after the front matter; and header and footer text with `{page}`, `{pages}`, `{case}` and `{title}`, optionally different on the cover page. The template's text overrides the theme's default (D24);</li><li>**roles**: exactly one drafting role, which always has full view, editing, sharing, publishing and managing people (validation refuses a template without them), and one or more reviewing roles. Each reviewing role has a view (`full` or `redacted`), may comment or not, may vote or not, and, if it votes, an approval rule (D6);</li><li>optionally a **conclusion section**, empty and hidden in every revision until the report is `concluding` (D18), written by the drafting role, redacted like any section, and an ordinary item in the comparison.</li></ul>**Choosing people.** When a revision is published, an author fills each reviewing role from a committee of the report's unit or with individual accounts. The publish dialog shows each role with its view, so a `full` role is never chosen unknowingly. A person holds at most one reviewing role in a round and never a reviewing role in a report they author. The participants are frozen in the round. Templates are created and edited only by template editors. Editing creates a draft version of the template; publishing it makes it available for new reports. A template in use can be retired, but never deleted or changed. Publishing a template version is logged with its editor and its differences from the previous version. The two ethics templates ship as built-in data, imported into every environment only if absent (by stable ID and version), so a redeploy never changes or revives one. They can be copied. The details can be tuned with the first users |
| D24 | Theme | One theme per deployment, set by an administrator: organisation name, logo (an uploaded image), primary and accent colours, a font for headings and one for text from the bundled set (D16), and the PDF header and footer text (for example "STRICTLY CONFIDENTIAL"). Shipped default: a neutral Quoroom theme, with no MSF material in the repository. The app checks colour contrast and refuses a theme whose text would be unreadable. Applied to the app and to PDFs |

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

`packages/domain` (templates, permissions, approval rules, comparison, redaction, numbering) is pure code over validated data. It has no clock, no randomness and no I/O, so the same code runs in the browser and in the Worker. The triage engine of iterations 1 and 2 was built the same way; it now lives only in their tags.

## Synthetic data only

The seed data (the built-in templates, and the triage cases imported for the frozen `iter2`) is invented and carries no personal data, so the repository can be shared without exposing anything sensitive.

## The design follows MSF's official branding guidelines

Colours, text colours and typography follow the guidelines published by MSF Barcelona-Athens at branding-guidelines.msf.es: white as the main colour, red `#D7211E`, black, and `#414141` for web text. An earlier version used values read from msf.ch (`#EE0000`, `#292929` and a navy), which do not match the guidelines and were replaced.

The typeface, Atlas Grotesk, is licensed and not bundled. The guidelines reserve it for external communications and name Arial for other materials, so the font stack uses Atlas first, then the bundled open-licence Hanken Grotesk, then Arial, until MSF decides.

The footer shows the positive logo in Catalan, and the app uses the organisation's Catalan name, Metges Sense Fronteres. All branding lives in `src/brand.ts` and `src/styles.css`, so another centre can change it in one place. Use of the MSF name and logo is being confirmed with MSF.

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

The web app loads and saves through ordinary Foldkit Commands that call the Effect RPC client. Foldkit's `KeyedQuery` is still experimental, and each screen loads its own data, so caching by key adds nothing yet.

## Stage 0 spikes (iteration 3)

Throwaway spikes, run on 12 Nov 2026 in `apps/web` with real Chromium 155 (`/usr/bin/chromium`, driven by `playwright-core` 1.65.0) and then deleted. No spike code and no dependency was kept; the versions below are what stages 4 and 8 add. Spikes 1 and 2 ran in `apps/web`; spikes 3 to 5 ran on a throwaway Cloudflare stack (see below) and left nothing behind either.

### Spike 1: Tiptap in a Foldkit `CustomElement`

Pass thresholds: everything works at 375 px; the stored JSON round-trips unchanged; `pnpm lint` passes on the wrapper; the lazily loaded editor chunk is under 250 KB compressed. **Result: pass.**

| Check | Result |
| --- | --- |
| Viewport | 375 x 740. No horizontal page scroll; the editor stays inside the viewport. Toolbar buttons are 44 px |
| Typing | Reaches the model as a debounced `change` Message |
| No cursor jump on echo | Typed 60 characters in the middle of a paragraph with echoes arriving during the typing, then four bursts with echoes between them: text and caret position exact. Negative control: with the version check removed, the same script fails (the text lands in the wrong place and a stale echo overwrites the document) |
| Table | Inserted, typed into with Tab, a row added: 3 rows |
| Column resize | Dragging the column border widens the cell and stores `colwidth` in the JSON |
| Image | Inserted through a file input (a data URL in the spike); stored as an `image` node |
| Undo | Removes the image, also from the stored JSON |
| Selection for a comment | Event reports `{ from: 1, to: 6, text: 'Hello' }` (ProseMirror positions and quoted text) |
| JSON round trip | `setContent(stored)` then `getJSON()` is string-identical to the stored value |
| External content | A higher version replaces the document; typing continues from there. A lower version (a late echo) is ignored |
| Lint | `pnpm lint` passes with the wrapper, the element class and the spike app in `src` |
| Editor chunk, lazy | 432,393 bytes raw, **134,775 gzip (-9), 114,609 brotli**. It is a separate chunk loaded by a Command; the main chunk (Foldkit and Effect, 300,123 raw, 97,855 gzip) does not contain it |

The check script passed 11 of 11 checks on four consecutive runs. Stage 4 recreates it as the permanent browser test (section 3, constraint 6).

Chosen: Tiptap 3.33.1, pinned exactly, importing single extensions instead of `@tiptap/starter-kit`:

- `@tiptap/core`, `@tiptap/pm` (ProseMirror: `prosemirror-model` 1.25.13, `-view` 1.42.9, `-state` 1.4.4, `-tables` 1.8.5)
- `@tiptap/extension-document`, `-paragraph`, `-text`, `-heading`, `-bold`, `-italic`, `-underline`, `-link` (brings `linkifyjs` 4.4.0), `-image`
- `@tiptap/extension-list` (bullet list, ordered list, list item)
- `@tiptap/extension-table` (it also exports `TableRow`, `TableHeader` and `TableCell`; `Table.configure({ resizable: true })`)
- `@tiptap/extensions` (`UndoRedo`, `Gapcursor`)

All are MIT and none touches Tiptap's cloud. None depends on `effect`.

How the wrapper works, for stage 4:

- `CustomElement.define({ tag: 'quoroom-editor', properties: { content: String, version: Number }, events: { change: { content, version }, selection: { from, to, text } } })`. The content is the ProseMirror JSON as a string.
- The element is plain DOM code in its own module. It lives in the light DOM and draws its own toolbar. Foldkit sets properties and listens to events, and never touches the inside. The module registers the element when it is imported, so a Command does `import('./editor-element')` and answers `CompletedLoadEditor`. The view renders the element only after that (a `Loading | Ready | Failed` union). Rendering it earlier would set the properties on a not yet upgraded element and shadow the setters.
- **Echo.** The element keeps `knownVersion`. A local edit increments it and emits `change` with the new number, debounced 250 ms with a 1 s maximum wait (so echoes also happen during long typing); it also flushes on blur and on disconnect. The Model stores that content and version and passes them back. An incoming `version` is applied only if it is greater than `knownVersion`, so the echo of the element's own change, even a late one, never touches the document or the caret. To replace the content from outside, the update increments the Model's version. Property setters read both values in a microtask, because Foldkit may set them in either order.
- A Foldkit toolbar would need a command channel into the element; the spike kept the toolbar inside the element, and stage 4 chooses between the two. The image caption of D3 is not proven by the spike (it needs a figure node); stage 4 adds it as a custom node. Images were a data URL here; the real flow resizes, uploads, and stores an ID.
- Wrap tables in an element with `overflow-x: auto` so that a wide table scrolls inside the editor, not the page. The resize handle and cell borders need the CSS the spike had (`.column-resize-handle`).
- Tiptap rendering in `happy-dom` was not tried; scene tests stub the element.

### Spike 2: PDF from a pure renderer, in the browser and in Node

Pass thresholds: under 3 MB; text extracted with `pdfjs-dist` identical between browser and Node; under 5 s in a phone-sized browser; the PDF chunk loaded lazily. **Result: pass.**

| Check | Result |
| --- | --- |
| Content | 20 pages: cover with an SVG logo (invented placeholder, no MSF material) and a transparent PNG; table of contents; 10 sections of synthetic text; two tables with a repeated header row (22 rows each); a 79 KB JPEG; header "STRICTLY CONFIDENTIAL" and footer "Page X of Y" |
| Fonts | Hanken Grotesk (headings), Source Serif 4 (body), Noto Sans Greek and Cyrillic (single runs); all embedded and subset (`pdffonts`: `emb yes sub yes`) |
| Size | **255,861 bytes (Node), 266,536 bytes (browser)**; limit 3 MB |
| Text | `pdfjs-dist` text of the 20 pages (46,398 characters) is **identical** in Node, in the browser, and in the browser under throttling. The bytes differ (the compression differs); only the text is compared |
| Table of contents | 10 of 10 entries show the page the heading is on |
| Time, 375 px viewport, no throttle | About 0.5 s from the click, including loading the chunk and the fonts (render 0.37 to 0.42 s; Node 0.38 to 0.5 s) |
| Time, 375 px, CPU throttled 4x (CDP) | **2.0 to 2.2 s** (render 1.64 to 1.79 s, chunk 0.28 to 0.32 s) |
| Lazy | No request for the PDF chunk before the click |
| Chunk | 777,952 bytes raw, 288,099 gzip, 246,125 brotli. No threshold applies; it is only loaded when someone asks for a PDF |
| Fonts on the wire | The eight `.woff` files total 122,792 bytes, fetched at generation time |

Chosen: **pdfmake 0.3.14**, pinned exactly (MIT; brings `pdfkit` 0.20.2 and `fontkit` 2.0.4; no `effect`), and **`pdfjs-dist` 6.5.438** as a dev dependency for the tests (`pdfjs-dist/legacy/build/pdf.mjs` in Node). pdfmake gave tables with repeated headers, a table of contents with page numbers, page numbers in the footer, SVG and image nodes, and font embedding as built-in features, and met every threshold on the first try. `pdf-lib` was not built: it has no layout engine (no tables, wrapping or table of contents), so each of those would be our own code. Font files: `@fontsource/hanken-grotesk` 5.3.0, `@fontsource/source-serif-4` 5.3.1, `@fontsource/noto-sans` 5.3.0 and `@fontsource/inter` 5.3.0 (static `.woff`, not the variable package the app already uses; pdfmake needs static instances).

How it works, for stage 8:

- One pure function builds the pdfmake document definition (in the real design, from the document description in `packages/domain`). It gets the fonts and images as inputs and runs unchanged in both environments. Only the adapter differs.
- Browser: `import pdfMake from 'pdfmake/build/pdfmake'` in a lazily imported module; fonts are `?url` imports fetched at generation time, passed as base64 to `pdfMake.addVirtualFileSystem({ name: base64 })`, then `pdfMake.addFonts(...)` and `createPdf(definition).getBuffer()`. Images are data URIs.
- Node: `require('pdfmake')` (the server build), `pdfmake.sharedVirtualfs.writeFileSync(name, Buffer)` for each font, `addFonts`, `setUrlAccessPolicy(() => false)` and `setLocalAccessPolicy(() => false)` (otherwise it warns), then `getBuffer()`.
- Table of contents: `{ toc: { title } }` plus `tocItem: true` on each heading. pdfmake resolves the page numbers itself in one pass. Page numbers: `footer: (currentPage, pageCount) => ...`. A header can differ on the cover: return `null` for page 1.
- The logo is an `svg` node (vector; shapes only, no text inside the SVG). A transparent PNG works.
- Set `info.creationDate` and `info.modDate` to a fixed value in tests.
- **D16 consequence.** fontkit reads `.woff` but not `.woff2`. The fontsource files are subsets per script (`latin`, `greek`, `cyrillic`, `latin-ext`, ...), and pdfmake has no per-glyph fallback. The renderer must therefore split each text into runs by script and give each run the font file for that subset (the spike did this for Greek and Cyrillic), and must keep spaces and punctuation in the Latin run. `latin-ext` covers names such as "Ș" or "ğ" and is larger (Inter 48 KB, Noto Sans 78 KB per weight). A glyph missing from every subset, and the placeholder D16 promises for Arabic and Amharic, were not tested; stage 8 does it.

### Spike 3: Worker CPU on Workers Free

Run on 12 Nov 2026 on a throwaway stack (`test_spike0c`, Worker `test-spike0c-app`, a Vite-built Foldkit Worker like `app`, with Workers Logs). The spike code was bundled from `apps/api` (so it used `effect@4.0.0`), served a real Effect RPC group and a plain `/api/images` route, and was driven from Node with synthetic content: a Tiptap-JSON-shaped 20-page document (10 sections, 54,000 characters of text, 110 KB of JSON, two 22-row tables, lists, images, about 800 text nodes, 30 invented aliases), and a 1 MB generated JPEG. Numbers are `cpuTimeMs` from the Workers observability API, joined to the Worker's own log line (operation, isolate, sequence number) by request ID. About 1,850 requests, all with outcome `ok`; **none reported `exceededCpu`**. `cpuTimeMs` is a whole number of milliseconds.

Pass thresholds: no request reports exceeded CPU; each operation under 8 ms when warm (the plan's limit on Free is 10 ms); sign-in recorded, no threshold. "Warm" is the third request or later of that operation in an isolate; I give median / 95th percentile / maximum. "Cold" is the first request an isolate handles, forced by redeploying (2 to 4 samples each; the first request of a fresh deploy always reported a sequence number of 1). **Result: pass, after changing how a draft is shared.**

| Operation (final design) | Warm p50 / p95 / max (ms) | Cold, first request in a new isolate (ms) | n warm |
| --- | --- | --- | --- |
| Save one section (7.6 KB JSON, `SaveSection`: Schema decode, batch of 3 statements with guards) | 3 / 6 / 10 | 20 to 25 | 35 |
| Share a 20-page draft, as 10 `ShareSection` requests (read the section, redact in place, stage it) | 2 / 5 / 7 | 22 to 25 | 394 |
| ...and the closing `FinishShare` (one batch, set-based `INSERT ... SELECT` with `json_group_array`, guard on the staged count) | 1 / 3 / 4 | 19 | 34 |
| Read a revision as a reviewer (membership check and the stored redacted text, 121 KB response) | 2 / 3 / 6 | 20 to 26 | 34 |
| Decode a 20-page document through the real RPC Schema (110 KB request body, `DecodeDocument`) | 4 / 6 / 7 | 22 to 54 | 34 |
| Notification pass, 20 due jobs (`/api/tick`, one batch: claim, recheck, deliver, mark) | 0 / 1 / 2 | 2 to 4 | 36 |
| Seeding the 20 jobs (20 inserts in one batch) | 0 / 1 / 1 | 2 | 35 |
| Image upload, one 700 KB chunk (size and signature check, native base64, 2 statements) | 2 / 3 / 5 | 4 to 7 | 73 |
| Image read, 1 MB in two chunks (one query, text returned as is) | 1 / 3 / 4 | 5 to 7 | 32 |
| Cron `scheduled` run (the same pass, then one row written) | not applicable | 3 to 9 (each run is on a fresh isolate; one run claimed 20 jobs) | 15 runs |
| **Sign-in** (D1 read, PBKDF2-SHA256 100,000 iterations, session insert), recorded only | 17 / 27 / 29 | 20 to 30 | 34 |

The 1 MB image came back byte for byte after the two-chunk upload. Every operation passes the warm threshold on the 95th percentile. A few single warm requests reached 10 ms (a save, a share section) and are why the pass is judged on the 95th percentile and not on the maximum; none was cut off.

**Cold requests.** The first request an isolate handles costs 19 to 54 ms for an RPC route (building the RPC server and the Schemas), against a nominal 10 ms limit, yet every one finished with outcome `ok`. Free allows some slack for cold starts. Stages 2 to 7 must therefore not depend on a cold request being fast, and must not do more work on it than on a warm one. Plain routes (`/api/tick`, images) cost 2 to 7 ms cold.

**What did not fit, and what replaced it.**

| Variant for sharing a draft | Warm p50 / p95 / max (ms) |
| --- | --- |
| One RPC with the whole document (decode, redact, stringify twice, 2 binds of 110 KB), as first written | 15 / 21 / 28 (**fails**) |
| Same with an ASCII fast path in the accent-folding (variant B) | 12 / 17 / 17 (**fails**) |
| Same with the outline-only Schema (sections checked, content `Unknown`) | 10 / 13 / 13 (**fails**) |
| One RPC with no body: read the stored sections, redact in place, one bind of 110 KB, original assembled by SQLite | 5 / 11 / 11 (fails on 95th percentile) |
| Same, without parsing or redacting (read and write 110 KB only) | 5 / 8 / 10 |
| Same, parsing but not redacting | 6 / 8 / 8 |
| **10 `ShareSection` requests and one `FinishShare`** | **2 / 5 / 7 and 1 / 3 / 4** |

The lesson is about bytes, not about the redaction or the Schema. The redaction of the whole document costs about 1 to 2 ms, the full-tree Schema decode about 1 ms more than an outline check, but each 110 KB that crosses into or out of D1 costs about 2 to 3 ms, and the same 110 KB in a request body (JSON parse plus the RPC machinery) about 3 ms. **Chosen: nothing larger than one section crosses the Worker in one request.** Sharing is a sequence driven by the browser: one `ShareSection` per section (the server reads the stored working copy, redacts it, and stages the result in a row), then `FinishShare`, which builds the draft rows with `INSERT ... SELECT` and `json_group_array`, so SQLite concatenates the original and redacted text and the Worker never holds them. `FinishShare` is guarded: it inserts only if the number of staged sections equals the number of sections of the working copy, and it removes the staging rows. A share that is interrupted leaves only staging rows, which a later share with a new ID ignores.

**Notes for stages 2 to 7.**

- **Full-tree Schema decoding fits.** A 110 KB document decodes at 4 ms warm in total (6 ms at the 95th percentile), 1 ms of which is the Schema itself (`Schema.Struct` with `Schema.Literals` for the node type, `Schema.suspend` for the tree, `Schema.Record` for attributes). The plan's fallback of validating only the outline on the server is not needed for one section (7.6 KB). It is no use for the whole document, though: whole documents must not travel in one request at all (see above).
- **Saves send one section; shares work per section.** A section the size of the test section (7.6 KB, about 2.5 pages) saves in 3 ms. Cost grows with bytes, roughly 1 ms per 30 KB, so a 20-page report written as a single huge section would not fit; the template editor should not offer sections that long, or the editor should split them.
- **Base64 must be native.** The image upload uses `Uint8Array.prototype.toBase64()`, which the Workers runtime provides: 2 / 3 / 3 ms warm for a 700 KB chunk. The `btoa` and `String.fromCharCode` fallback took **22 / 39 / 43 ms** for the same chunk and fails. The image route must use `toBase64()`, and `fromBase64()` is the counterpart for any decoding. The `workerd` build (1.20261012.1) must be checked for it in stage 4 or 7, since the self-hosted build is the one that could lack it.
- **Statements.** All writes used `D1Database.batch` with guards (`WHERE EXISTS`) as constraint 3 of the plan describes. A batch of three statements for a save did not stand out. `RETURNING` was not used in the spike.
- **JSON stays text.** Stored and read as text columns; reading a 121 KB redacted revision and returning it as a string field costs 2 ms. Parsing JSON only where the server has to look inside it.
- **Redaction.** One combined regular expression with the aliases sorted longest first, folded text (accent-insensitive by taking the first code point of each character's NFD form, with an ASCII fast path), Unicode-aware word boundaries, replaced by index on the original text, and the tree changed in place after `JSON.parse`. About 1 ms per 54,000 characters in Node. The per-character `normalize('NFD')` without the ASCII fast path costs about four times that and should not be used.
- **Reading is cheap, sharing is the heaviest thing.** If the reviewer's read ever needs a join or a transformation, measure it again.
- **Sign-in** costs about 17 ms warm, 27 at the 95th percentile and up to 30 cold, with no failure or cut-off in 40 calls. This matches iteration 2 on the same plan. The iteration count was not touched.
- **Workers Logs.** Invocation logs carry `cpuTimeMs`, `wallTimeMs` and `outcome` per request (`$workers`), and a `console.log` line shares the `$metadata.requestId`, which is how the operation and isolate were joined. Events appear about 30 to 60 seconds after the request. The query needs `view: 'events'`, and paging uses `offset` as the last event's `$metadata.id` with `offsetBy: 0` and `offsetDirection: 'next'`.
- **Test method.** Use a fresh deploy (a changed bundle gives new isolates) and check the response header `x-seq` of 1 to know a request was cold. Concurrent requests did not produce many new isolates (ten concurrent chains used three).

### Spike 4: `scheduled` in the Vite-built Foldkit Worker

Pass threshold: the handler runs on a test environment with a one-minute cron and writes a row. **Result: pass.** On `test-spike0c-app` the handler ran every minute (a row in a `cron_log` table every 60 seconds, written about 0.8 s after the scheduled time; 15 scheduled invocations were logged in all), and a run with 20 due jobs seeded claimed all 20.

How it is wired, for stage 7:

- The `Cloudflare.Website.Foldkit` resource accepts the Worker's `crons` prop: `crons: ["* * * * *"]` next to `main`, `env` and `assets`. Alchemy reconciles the Cron Triggers as part of the Worker's deploy ("Reconciling Cron Triggers (1)"); the schedule was visible through the Workers API (`GET /workers/scripts/<name>/schedules`) and was removed with the Worker on destroy. No other resource is needed. The environment's cadence (D12) is therefore a stack setting: a cron every minute on test environments, a slower one on demo and pilot.
- The entry file named by `main` exports `scheduled(controller, env, ctx)` next to `fetch`, as an ordinary `ExportedHandler`. The Vite build kept it. Do the work inside `ctx.waitUntil(...)`; `controller.scheduledTime` and `controller.cron` are available. The handler builds its own D1 access from `env.DB` and does not go through the per-request RPC app.
- CPU of the scheduled run: 3 to 9 ms (15 runs, each on a fresh isolate), with 20 due jobs in the one where they were present.
- Failure and retry of a failing run were not exercised. The pass must be safe to run twice (claims are guarded, as in constraint 3).
- Account usage during the spike: 1 Cron Trigger (limit 5) and 3 D1 databases (limit 10). `workerd` does not fire crons, so `/api/tick` stays for self-hosting.

### Spike 5: D1 EU jurisdiction

Pass threshold: a database is created, used and destroyed. **Result: pass.** `Cloudflare.D1.Database("...", { jurisdiction: "eu", migrations })` created the database in 2.3 s with its migration applied. The Cloudflare API lists it with `jurisdiction: "eu"` (the other, default one shows none). The Worker bound it as an ordinary `DB`-style binding, inserted a row and read the count back, and the destroy removed it in 1 s; afterwards the account listed only the live database.

Notes for stage 3:

- The only change is the `jurisdiction` prop; bindings, migrations and `importFiles` behave as for a default database. Alchemy's type is `"default" | "eu" | "fedramp"`.
- Per Alchemy's own documentation, changing `jurisdiction` (or `primaryLocationHint`) later replaces the database, and with a fixed `name` it deletes the old one first. Set it before the pilot's first deploy and never change it afterwards.
- Alchemy generated the database name from the stack, resource and stage (`Spike0c-SpikeDbEu-test-spike0c-<suffix>`), so test stacks never collide with live names.
- Whether the EU database also serves faster or slower from Spain was not measured; the first call through the Worker (cold, insert and count) took 151 ms wall time.

### Safety record of the run

Stack `Spike0c`, stage `test_spike0c`, alchemy file `alchemy.spike0c.run.ts` (deleted). Every plan and deploy named only that stage; the plan showed 3 creations and no change to anything else. The destroy removed the Worker, both databases and the cron; the account listing afterwards matched the state before the spike. `live_uripont` was never planned, deployed or destroyed. The smoke check passes (4 of 4) on `app` and `iter2` afterwards.


## `playwright-core` for the browser check (stage 3)

`packages/e2e` is the one place that drives a real browser. It uses `playwright-core` 1.65.0 (no bundled browsers) with the system Chromium (`/usr/bin/chromium`, or `E2E_CHROMIUM`), so nothing is downloaded. It is a dev dependency of that package only, has no `test` script (so `pnpm test` and `pnpm check` do not need a browser) and starts its own workerd on a free port with a temporary data folder. Run it with `pnpm --filter @case-desk/e2e e2e`.

## Other browser engines for the sweep (stage 10a)

The sweep of every route (`packages/e2e/src/sweep.ts`) and the keyboard and session steps (`keyboard.ts`) run in Chromium and Firefox. Firefox is a dev-time download, not a project dependency: `pnpm --filter @case-desk/e2e exec playwright-core install firefox` puts Firefox 159 (build 1572) in Playwright's cache (`$PLAYWRIGHT_BROWSERS_PATH`, else `$XDG_CACHE_HOME/ms-playwright`). `playwright-core` launches it from there with no executable path. `E2E_ENGINES=chromium` runs Chromium only (used for the repeated flakiness runs); `E2E_SKIP_SWEEP=1` skips the route sweep.

WebKit cannot run on this machine. `playwright-core install webkit` downloads it, but the host is Arch Linux without `sudo`, and the WebKit build needs `libicu*.so.74`, `libxml2.so.2`, `libjxl.so.0.8` and `libbacktrace.so.0`, which the system does not have (it has newer, differently versioned ones; `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` gets past the check and then the binary fails to load). It needs `sudo npx playwright install-deps` or a Debian/Ubuntu host. Safari is therefore not covered by a real engine; the screens use no engine-specific features, and Firefox (Gecko) and Chromium (Blink) agree on all of them.

The route list is not written by hand: `AppRoute.members` is read from `apps/web/src/route.ts`, a route without a sample in `sweep.ts` fails the type check, and the sweep fails if the two lists differ.

## A session that ends, and Escape (stage 10a)

A signed-in call answered `Unauthorised` announces `quoroom-session-ended` on the window (`withQuoroom`, after the screen has had its failure). The app shows the sign-in at the same address and keeps every screen's Model; the same account signing in again resumes (unsaved report or template edits are saved at once), a different account starts from empty screens, so nothing of one account is shown to another. Escape answers an open in-page question (leave, remove, discard, retire, send, confirm) with "no" through the screen that asked it, the question takes the focus when it opens, and the focus returns to what opened it.

## Bundled fonts for the theme (stage 3c)

The theme (D24) offers a fixed set of fonts served from the app itself, with no request to a font provider. Three packages were added to `apps/web`, pinned exactly, all under the SIL Open Font License:

- `@fontsource/inter` 5.3.0 (body)
- `@fontsource/source-serif-4` 5.3.1 (body, serif)
- `@fontsource/noto-sans` 5.3.0 (body, with Greek and Cyrillic)

They join `@fontsource-variable/hanken-grotesk` 5.3.0 (headings). None depends on `effect`. The same files feed the PDF renderer (spike 2, D16). The MSF logo is not in the repository: the unused `apps/web/public/brand` folder was removed in stage 3d. Frozen iterations are built from their tags, so `iter2` is unaffected.

## The pilot stack and the test environments (stage 3d)

`alchemy.pilot.run.ts` is a separate stack named `Quoroom`, apart from the demo stack (`TriageDesk`, stage `live_uripont`), so deploying or destroying one never touches the other.

- **Stages.** Only `pilot` (Worker `pilot`) or `test_<name>` (Worker `test-<name>-pilot`). The file throws for any other stage, including the `ALCHEMY_STAGE=live_uripont` in `.env`.
- **Commands.** `pnpm pilot:plan|deploy|destroy` always pass `--stage pilot` and refuse `--stage`, `--config` and `--env-file`. `pnpm test-env:up <test_name> [--fast]` deploys with `--yes` and prints the URL; `pnpm test-env:down <test_name>` destroys it. Both refuse a stage that does not match `test_[a-z0-9]+` (so `pilot` and `live_uripont` are refused). `--fast` sets `QUOROOM_FAST_TIMINGS=1`: reminders 10 and 3 minutes before the deadline instead of 48 h and 4 h. The pilot stage ignores it.
- **Database.** Its own D1 with `jurisdiction: "eu"` (never change it after the first deploy: it replaces the database), the migrations, `apps/api/seed/builtin-templates.sql` (insert-if-absent, generated from the domain by `pnpm --filter @case-desk/api templates:sql`, kept in sync by a test), and `.local/grants-<env>.sql` if present (`pnpm grant-admin --env pilot|test-<name>`). No demo cases, no `users.sql`.
- **Demo and pilot (D20, revised 14 Nov in slim-down pass 1).** The latest code is Quoroom only and has no runtime mode: the Worker reads no `RUNTIME_MODE`, `/api/config` serves the public theme only, and `app`, the pilot and `workerd` run the same code. The triage desk of iterations 1 and 2 lives only in the frozen `iter1` and `iter2`, built from their tags; `iter2` has its own Worker and API, so `app` no longer serves `/api/login`, `/api/logout`, `/api/session` or `/api/rpc` (404 everywhere). Demo and pilot now differ only in what is deployed and imported: the demo stack runs `iter1`, `iter2` and `app` on one database that also imports `.local/users.sql` and `seed/demo-cases.sql` for `iter2`; the pilot stack imports the built-in templates and the first-admin grants only. `pnpm workerd --mode demo|pilot` chooses the embedded imports (demo adds `users.sql`; neither embeds the triage cases) and the data folder. Kept because `iter2` reads the same `users` and `sessions` rows: the cookie `case_desk_session`, the 32-byte hex session token stored as its SHA-256, and the PBKDF2 password hash. Before this pass `RUNTIME_MODE` was `demo` or `pilot` (unset meant `pilot`, anything else a 500), and the demo kept the triage desk visible in `app`.
- **Worker.** The `NOTIFY_*_MINUTES` timings as variables, a Cron Trigger (every minute on `pilot` and on test stages; changed from every 5 minutes in stage 7) that calls `scheduled`. `scheduled` runs the notification pass (stage 7, `apps/api/src/tick.ts`).
- **Observability.** Workers Logs on, invocation logs off (they record the URL), traces off, Issues on. Logs keep what the code writes, errors included; no request body is ever logged. Stage 10 checks this with a search for invented text. A test stage can turn invocation logs on (`pnpm test-env:up test_<name> --invocation-logs`, `QUOROOM_INVOCATION_LOGS=1`) for CPU measurements; the pilot stage ignores it, and a test checks the stack file.
- **workerd.** `pnpm workerd --mode demo|pilot` (default demo). Pilot embeds the built-in templates and `grants-workerd.sql` only and keeps its data in `.local/workerd-data-pilot`; demo also embeds `users.sql`. The code served is the same (D20).
- **Free plan.** One Cron Trigger and one D1 database per environment; a test environment is always destroyed after use.
- **Pilot stack guards.** `scripts/pilot-stack.mjs` passes only `--yes`, `-y`, `--dry-run` and `--detailed` to alchemy and refuses `--profile`, `-p` and every other flag. It always passes `--profile default` and refuses to run when `ALCHEMY_PROFILE`, `CLOUDFLARE_ACCOUNT_ID` or another account-selecting variable (nine names in `scripts/pilot-guards.mjs`) is set, in the environment or in `.env`, to anything but the default. The message names the variable, never its value. `test-env:down` also removes `.local/grants-test-<name>.sql`.
- **First-admin imports apply once.** Each generated grant file carries a unique import ID recorded in `applied_imports` (migration 0005); its statements run only when the ID is absent, so a re-run on every deploy or workerd start cannot undo a revocation. `grant-admin --reset` checks the local workerd database (account exists, has a password, is active); for D1 it prints that the link works only if the account exists and is active.
- **Referrer-Policy on static assets.** `apps/web/public/_headers` sets `Referrer-Policy: no-referrer` for all paths, because assets bypass the Worker (`runWorkerFirst: ["/api/*"]`). A test builds the web app and checks `dist/_headers`.
- **`/api/config` is minimal.** It serves the public theme only (colours, fonts, organisation name). PDF header and footer text is read through the session-gated `GetTheme`.
- **Legacy sign-in.** Removed in slim-down pass 1: `/api/login`, `/api/logout` and `/api/session` answer 404 in every environment (D20). Only the Quoroom `SignIn` (`quoroom/signin.ts`) signs in.

## Stage 4c: the rich-text editor (iteration 3)

- **Dependencies (exact, `apps/web`).** `@tiptap/core`, `@tiptap/pm`, `@tiptap/extension-document`, `-paragraph`, `-text`, `-heading`, `-bold`, `-italic`, `-underline`, `-link`, `-list`, `-table` and `@tiptap/extensions` (`UndoRedo`, `Gapcursor`), all 3.33.1 as in spike 1. `@tiptap/extension-image` is not used: images are our own `figure` node. No other dependency. The element is `apps/web/src/quoroom/editor/element.ts`; the binding without Tiptap is `spec.ts`.
- **Toolbar: inside the element, with its logic pure.** What a button shows (mark on at the caret, undo possible, caret in a table) changes with every ProseMirror transaction. Through Foldkit it would be a Message per key press and a command channel into the element. The element draws the toolbar and the link box; `toolbar.ts` (no Tiptap, no DOM) holds the buttons, their groups, `buttonState`, and the link address rule, and is unit tested. A Foldkit toolbar can still be built later on the same pure module if the command channel is ever needed.
- **Schema.** `extensions.ts` is exactly the domain schema: headings 1 to 4, no hard break, list items and table cells hold paragraphs, headings and lists only, links `http`, `https`, `mailto`, `tel`, and a `figure` node (`imageId`, `alt`, `safeToShare`, caption without marks). Tiptap 3.33 writes `align` on cells and `title: null` on links, which the strict schema refuses, so both attributes are removed from the extensions. Every change is decoded with `decodeRichText` and made canonical in the element, and decoded again in `update` (`ChangedRichText`), so the Model and the save only ever hold canonical JSON. A document of one empty paragraph is stored as no value. A refused change shows a notice and is not saved.
- **Tiptap bug worked around.** After undo of a column resize, `TableView` leaves the old `width` on the `<col>`, so the screen disagreed with the document. `ClearingTableView` clears it.
- **Lazy loading.** `LoadEditor` (a Command, `import('./editor/element')`) runs when a section with a rich-text item the author may edit is first shown; the element is rendered only in `Ready`. A read-only report, a section that is not in force and a shared draft use `richTextView.ts`, a plain Foldkit view of the domain document, and never load Tiptap. Measured on the build: the editor chunk is 433,319 bytes raw, **135,007 gzip (-9), 114,791 brotli**; the browser check asserts it is not requested before a rich-text section is shown and is under 250 KB gzip.
- **Selection.** The element emits `selection` with ProseMirror `from`, `to` and the quoted text when a range is selected and once when it is cleared. `SelectedRichTextRange` keeps it in `maybeSelection` (a stub consumer for stages 4g and 6).
- **Known limits.** Column resizing is by mouse or pen: ProseMirror's resize plugin has no touch drag, so on a phone widths are not adjustable by touch (add and remove rows and columns, header row, and scrolling inside the box work). Images: the toolbar button is disabled and a figure is shown as a labelled box with its caption until 4d. A link title is not editable. The selection event is sent 200 ms after the selection settles. Pending edits are flushed on blur, so the last 250 ms are normally kept when an author moves to another section, but a flush at disconnect may not reach the Model.
- **Demo build templates.** `workerdImportFiles('demo', ...)` now starts with `apps/api/seed/builtin-templates.sql` (as the pilot does) and the demo stack's `Database` `importFiles` in `alchemy.run.ts` lists it first. It is insert-if-absent, so it is additive and idempotent within D22. Nothing was deployed; stage 10 deploys it.

## Stage 7: the notification pass (iteration 3)

- **State machine of a job** (`notification_jobs`): `pending` (due at `due_at`) -> `claimed` (until `lease_until`, by one pass) -> `done` | `skipped` | `failed`. A `failed` job with a `retry_at` is claimed again at that time; one without is final. A claim whose lease has run out is claimed again too, so a pass that stops halfway loses nothing. Each claim counts an attempt; after 5 (`MAX_ATTEMPTS`) the job is a final failure. Back-off after a failed send is 1, 2, 4, 8 minutes, at most 15. A job released unprocessed (the query budget ran out) goes back to `pending` and the attempt is given back.
- **No duplicates.** The claim is one `UPDATE ... WHERE id IN (SELECT ... ORDER BY due_at LIMIT ?) RETURNING`, and every write that finishes a job is guarded by `state = 'claimed' AND claimed_by = ?`, so a pass whose lease was taken over cannot overwrite the new owner. The in-app inbox item is the `done` job row itself, so inbox delivery cannot be duplicated at all. Channels that leave the app (WhatsApp, stage 11) are at least once; the job's idempotency key is given to the channel.
- **Recheck.** Before sending, each job is checked with `isJobNeeded` against fresh state (a decided round, a newer revision, a removed reviewer, a review already sent, an approval preference). Not needed: `skipped`, nothing is sent.
- **Deadlines.** The pass loads each report with the same `loadReport` the handlers use, which decides a round past its deadline and writes its `round_decided` jobs; those are delivered in the same pass by a second, scoped claim.
- **Sizing for Workers Free.** At most 5 jobs per claim, at most 1 report per run (2 until stage 10, see "Stage 10: log test and CPU"), and 50 D1 queries per pass; the pass counts the real queries, reserves 21 per report (measured worst case for a report whose deadline decides, with `loadRaw` retries: 20), 7 to finish and 8 for `cleanupStale` and pruning, and releases what it cannot reach. A report is read in one D1 batch (`readReport`, 7 statements, no users join) and the pass uses a slim template (roles and whether a conclusion exists). Measured: see the execution log.
- **Channel.** `NotificationChannel.send(message)` takes the template name and ordered parameters (shaped for Meta), a link and an idempotency key, and returns `Sent {providerMessageId, deliveryStatus}` or `Failed {retryable, reason}`. Stage 11 adds WhatsApp with the same interface.
- **Starting the pass.** The Worker's `scheduled` handler (errors logged, never rethrown) and `POST /api/tick` (guarded by `TICK_SECRET`, constant-time compare, 404 when unset) both call `runNotificationPass`. The demo `app` Worker in `alchemy.run.ts` has `crons: ["* * * * *"]` (every minute; first set to every 5 minutes), which takes effect only when the demo is next deployed (it is not deployed by this stage; D22). `iter1` and `iter2` get no cron and no `TICK_SECRET`. The pilot stack has one cron, every minute on the pilot and on test stages.
- **Timings** come from `NOTIFY_REQUEST_DELAY_MINUTES`, `NOTIFY_FIRST_REMINDER_MINUTES` and `NOTIFY_FINAL_REMINDER_MINUTES`, read by handlers and by the pass the same way, so jobs are written with the timings the pass assumes. Invalid values fall back to the defaults with a logged line.
- **Migration 0007** adds `retry_at` and `last_error` (expand only).

### Stage 7 review fixes (iteration 3)

- **Counters.** `attempts` counts only real channel failures (limit `MAX_ATTEMPTS`). `deferrals` (migration `0008_notification_deferrals.sql`, additive) counts lease takeovers and storage errors, retried after the same back-off, with its own larger cap `MAX_DEFERRALS` (50); reaching it logs an error and fails the job. A killed pass never fails a job permanently.
- **Inbox.** `ListNotifications` carries no case reference, title or content for any role, only generic lines, ids, times and the deadline with its zone. Test: 101 reports and a removed redacted reviewer.
- **Refused decisions.** If the store refuses a decision every time, the round is not reported as decided or stored and the deadline job stays pending. A failed `listProfiles` leaves jobs for retry, not skipped.
- **Starting the pass.** The claim is raw SQL before any Effect layer: an idle run is one query. Housekeeping (`cleanupStale`, pruning) runs only in the first minute of each hour. Cron is every minute on the pilot, test stacks and demo `app` (not deployed). `NOTIFY_*` is parsed once per isolate. `/api/tick` answers 404 to every request unless the secret matches on a POST.
- **Web.** `GetUnreadCount` polls every 30 s, backs off to 5 min when nothing changes, pauses while the tab is hidden and refreshes on focus. A partial index serves the unread counts.
- **CPU (Workers Free, 10 ms).** Scheduled `cpuTime` from the GraphQL analytics on `test_cpu7 --fast` with 6 reports: before these fixes (one pass of up to 20 jobs, per-report reads) p50 about 18.5 ms, p99 41 ms; after (30 runs, 08:12 to 08:41 UTC) p50 5.1 ms, p90 20.1 ms, p99 32.4 ms, all 30 with outcome success; idle runs 3.1 to 3.8 ms, busy runs 11 to 32 ms; HTTP requests had no exceeded-CPU outcome. The target of p99 under 10 ms was not reached: idle runs cost about 3.5 ms (startup and one query), and the busy ones are dominated by the work of a pass (Effect layer, Schema decode, 2 reports of D1 round trips), not by the formatter caching or role decoding. Next options if the plan refuses runs: split a pass over more invocations, or a Durable Object alarm.

## Stage 8: PDFs and downloads (iteration 3)

- **Libraries, pinned exactly.** `pdfmake` 0.3.14 (`packages/pdf` and `apps/web`), `pdfjs-dist` 6.5.438 (dev only, to read PDFs back in tests; legacy build, no worker), `esbuild` 0.28.2 (dev only in `packages/pdf`, bundles the Node runner; the same version as `apps/api`). Fonts: the static `.woff` files of `@fontsource/hanken-grotesk` 5.3.0, `inter` 5.3.0, `noto-sans` 5.3.0 and `source-serif-4` 5.3.1 (subsets `latin`, `latin-ext`, `greek`, `cyrillic`; regular, bold, italic, bold italic). `apps/web` already had the other three; `@fontsource/hanken-grotesk` (static) was added because it had only the variable package, which fontkit cannot read.
- **Where the code is.** `packages/domain` stays pure and only describes the document (`documentDescription`, `approvalRecordDescription`, `pdfFileName`, D10). `packages/pdf` maps that description to a pdfmake definition (`definition.ts`, no DOM, no Node API) and has two thin adapters: `node.ts` (reads fonts from disk, used by tests and `scripts/render.mjs`, the Node runner: `node packages/pdf/scripts/render.mjs job.json out.pdf`) and `browser.ts` (pdfmake's browser build, fonts handed in by the caller). `apps/web` loads the browser adapter with `import()` in one lazy chunk, only when someone asks for a PDF. The chunk is 781 KB raw, 291 KB gzip (the spike measured 288 KB). The font files are separate assets, fetched one by one when a document needs them; nothing is fetched by pdfmake itself (URL and local access policies refuse everything).
- **Per-script fonts.** The renderer splits every text into runs by script from the fontsource `unicode-range` tables, in NFC, and gives each run the font file of its subset (D16). Hanken Grotesk has no Greek or plain Cyrillic subset, so those runs use Noto Sans. A run of characters no subset covers (Arabic, Amharic, Chinese, symbols) is replaced by one short `[?]`, never handed to a font. Common symbols are first mapped to what the fonts have (≤ `<=`, ≥ `>=`, ≠ `!=`, ≈ `~`, arrows, ✓ `(yes)`, ✗ `(no)`, ℃, ℉); a combining mark no subset covers is never dropped silently but shows the marker too; control and invisible characters are dropped. A test checks with fontkit that every family, script and face has a glyph for what its range says.
- **Contents and page numbers.** pdfmake's own table of contents prints only global page numbers, and its header and footer functions get only global page numbers. The cover, front matter and body are therefore one section each with a recording `background`, the contents is drawn by us (a title and a fixed 40 pt label column, each row a link to its heading) and the document is rendered twice when it has a contents: the first pass learns the page each heading lands on, the second prints the labels. The cost is about one extra second for a 50-page report. Header and footer text have `{page}`, `{pages}` and the other tokens, a different one on the cover, roman numerals for the front matter when the numbering restarts. Tests compare the printed labels with the pages pdfjs finds each heading on.
- **Zip: our own store-only writer, no `fflate`.** PDFs are already compressed, so deflate would save little; the writer is 100 lines (`zip.ts`: UTF-8 name flag, CRC-32 checked against `node:zlib`, a fixed time for byte-identical output, no zip64: 4 GB or 65,535 entries are far beyond a report). It is checked with `unzip -t`. One dependency fewer.
- **What a person may download.** The server lists the versions: every shared draft and every revision in both views for authors (`GetDownloads`, drafts in both views since this stage) and the approval record once a round is decided. A redacted reviewer has no list: the revision screen has one button, and the server picks the view (`RevisionOutline.view`; the revision's published date is now `RevisionOutline.publishedAt`). Content is always the server's: a redacted PDF is built from content the server already redacted, and a figure the redacted view withholds is not in the description, so it is never fetched or embedded (a test searches the bytes of the PDF for the image). Images are read through the image route with the version context (`draft` or `revision`), decoded chunk by chunk.
- **Dates and file names.** The date on a PDF is the day the version was shared or published (UTC), not today, so the same version prints the same twice; the approval record has the day it was made. File names follow D10; the zip is `<reference>_<template>_all-versions.zip`.
- **Checks.** For the three templates, original and redacted: multi-page, every heading in order (twice when there is a contents), numbering, report name, revision, date, the redaction label only in redacted files, no alias in the text or the document info by an independent tokenizer, the same text on a second render. The browser run is compared with Node on the same data in the 375 px browser check (identical extracted text).

## Stage 9d: the theme screen (iteration 3)

- **The logo is served behind the session.** The theme's logo is an image owned by the theme (`owner=theme` on upload, administrators only; `context=theme` on read, any signed-in account). `/api/config` is public and cached for 30 s, and carries only a reference to the logo (id, type, chunk count), never its bytes. The signed-out sign-in screen therefore shows the organisation's name and colours but no logo; the app loads the logo once someone is signed in. Reason: the logo goes through the image route that already checks sessions and chunks, there is no second public image path to keep safe, and a public file would be cached without our control. The stored logo is always the organisation's own upload; no logo is ever kept in the repository.
- **Reading and saving.** `GetTheme` (signed in) returns the full theme with the PDF texts; `UpdateTheme` (administrator, `set_theme`) refuses unreadable contrast, unknown tokens and an incomplete or foreign logo. The screen checks the same domain function (`validateTheme`) while typing and shows each problem next to its field, and the server checks again. Saving updates the app's config in memory, so the name, colours and logo apply without a reload; a fresh load may see the old public config for up to 30 s.
- **Preview.** The app preview is styled with the typed colours (invalid ones fall back to the saved ones). The PDF preview is made on request, in the browser, with the lazily loaded PDF chunk and `sampleDocumentInput(theme)` (an invented one-section report); it is debounced by 400 ms, stale results are dropped and old blob URLs are revoked.
- **Header and footer.** A template's own header, footer, cover header and cover footer replace the theme's; the theme's apply where the template has none (the intake template has no cover texts, so the theme's cover texts print on its cover).
- **Template editor folding.** Sections are folded by default, except the Sections panel and the section being edited; a problem forces its panel and every section above it open.

## Stage 8+9 review fixes (iteration 3)

- **Template drafts.** A draft has a revision counter (`draft_revision`): a save or a publish that did not see the latest one is a Conflict (`stale_save`) and the editor offers a reload. Retiring is sticky: a retired template gets no new published version until it is restored (`RestoreTemplate`). A broken draft is removed with `DiscardTemplateDraft`. Built-in templates take copies only. `ListTemplates` pages (offset, limit) and names the published version, with the draft's name apart.
- **PDF colours.** The table header fill, header and footer text and rules are derived from the theme so that text keeps 4.5:1 contrast for every theme `themeProblems` accepts, dark ones included (`derivedColours`, property test).
- **Conclusion in a PDF.** An author's PDF has the conclusion only when the report is concluding or archived, or the conclusion has content (the domain default); a reviewer's when the revision is the closing one or the conclusion has content. A section that cannot be read fails the file; no error is swallowed (the server answers an empty section for a missing row).
- **People in a reviewer's PDF.** `RevisionOutline` carries `personLabels` (id and label only, never names or aliases); a people item prints the label for `redacted` and `full` reviewers. `publishedAt` is required: the date of a reviewer's PDF is never 1970.
- **Download all.** Files are rendered one at a time; images already read are kept for the next versions. The zip is built from parts (no copy of it), carries the newest version's day as its time stamp (same report, same bytes) and is refused above 1.5 GB or 60,000 entries with a message.
- **Theme logo.** Preview addresses are revoked when replaced, removed, loaded again or the screen is entered again; the one the app holds is kept until a later save replaces it. The app gets the logo reference (type and chunks) from the upload even if the preview never loaded, and the configuration is never rebuilt with an invented mode. A replaced logo is an unreferenced image: the stale-image cleanup of the notification pass removes it after a day (test).

## Stage 10: log test and CPU (iteration 3)

Run on 13 Nov 2026 on one test environment of the pilot stack, `test_s10b` (Worker `test-s10b-pilot`, `RUNTIME_MODE=pilot`, `--fast`), created at 13:34 UTC and destroyed at 14:51 UTC; afterwards the account lists no test Worker or database. Driven by `apps/api/scripts/live-run.mjs` (it bundles `live-run.ts` and runs it: the real RPC client, a cookie per person, every call recorded with its `cf-ray`) and read with `scripts/workers-logs.mjs` (Workers observability API, test Workers only, prints counts, never events). Both refuse any address or Worker that is not a test one.

**Log test: pass.** `live-run pilot` creates the administrator's account from a `grant-admin` link, a unit, two authors and two reviewers, then one report through every step with invented marker strings (random syllables, unique per run) in the case file reference and title, the people's names and aliases, every section, an image caption and alt text, a draft comment, comments for authors and for the committee, a reply, the conclusion, a refused save and review, a wrong sign-in for an invented address, a malformed and a broken RPC body; it shares, publishes three revisions (changes requested, approved, closing approved, archived), waits for the cron's notification pass to deliver the review request and the outcome, reads downloads, the approval record, the grid, the audit and the history, and signs out and in again. Results:

- Pilot configuration (invocation logs off, as on `pilot`): 34 markers, **none found** in the Workers Logs, by the API's free-text search and by a scan of every event of the window. Positive control: `notification_pass`, which the pass writes, is found by both (4 events).
- The same environment with invocation logs on (they record the URL and headers): a control marker in the path of a 404 request **is found** (1 event, by both), while 322 markers sent in request bodies (the pilot path again and the load below) are **not found** in 1,376 events. So the search would find a marker that reached the logs, and request bodies never reach them even with invocation logs.
- Configuration read back from the Workers API for the pilot setting: logs on and persisted, `invocation_logs: false`, traces off, Issues on. The code writes only `console.error` messages without content and the pass summary (counts).

**CPU: the thresholds of spike 3 are not met; nothing was cut off.** `cpuTimeMs` of every invocation (invocation logs on), joined to the procedure by `cf-ray`; 1,962 requests and 54 scheduled runs, every outcome `ok`, **none `exceededCpu`**. Spike 3's "warm" (third request of an isolate, from an `x-seq` header) cannot be told here, so these are all requests; leaving out the first two of each procedure changes nothing that matters. Sections of about 6 KB of text. ms, p50 / p95 / p99 (n):

| Procedure | p50 / p95 / p99 | n |
| --- | --- | --- |
| `GetRevisionSection` (reviewer reads a section) | 8 / 12 / 16 | 532 |
| `SaveSection` | 7 / 12 / 19 | 374 |
| `GetDraftSection` | 7 / 10 / 13 | 302 |
| `ShareSection` | 11 / 17 / 22 | 151 |
| `FinishShare` | 11 / 19 / 19 | 15 |
| `GetWorkingCopySection` | 7 / 10 / 13 | 130 |
| `GetRevisionOutline` | 10 / 14 / 14 | 54 |
| `PublishRevision` | 12 / 21 / 21 | 15 |
| `SendReview` | 14 / 23 / 23 | 18 |
| `AddComment` | 8 / 12 / 32 | 26 |
| `GetUnreadCount`, `ListInbox` | 4 / 7 / 8 | 26, 25 |
| `GetGrid` | 10 / 46 / 46 | 13 |
| Sign-in (`SignIn`, recorded only) | 30 / 58 / 58 | 10 |
| Image upload (one chunk) and read | 11 and 10 | 1 each |
| Baselines: `/api/tick` 404 (no API built); a 404 under `/api/` (API built, no query); `/api/config` (one query); RPC without a session | 0; 1 / 2; 2 / 4; 2 / 7 | 25 each |
| **Notification pass, busy** (`scheduled`, 2 reports per run) | 19 / 33 / 34 | 25 |
| **Notification pass, busy, 1 report per run** | 17 / 28 / 31 | 24 |
| Notification pass, idle (one query) | 5 / 6 / 6 | 5 |

Every authenticated procedure is above spike 3's 8 ms at the 95th percentile, and the busy pass is well above it. The spike's operations cost 1 to 4 ms at the median; the real ones 7 to 14. The baselines show where it goes: building the API for a request costs about 1 ms and an unauthenticated RPC 2 ms, so most of the cost is the work of a real procedure (the session check, the report and membership reads with deadline settling, the guarded write batch), roughly 1 ms of CPU per D1 round trip, not the size of the content. A pass that sends two jobs of one report costs 13 to 26 ms against 4 to 6 ms when idle, so the pass is dominated by its fixed work (Effect layer, the report read, the profiles, the finishing batch), not by the number of reports.

- **Change made:** `MAX_REPORTS_PER_RUN` from 2 to 1, as the plan prescribed. It lowers the busy pass by about 2 to 5 ms (p95 33 to 28, maximum 34 to 31) but does not bring it under 8 ms; jobs of other reports are released unspent and sent by the next runs (one report per minute on the pilot, enough for its size). Tests updated (more passes for the many-report cases).
- **Not changed:** no procedure was rewritten; nothing smaller and bounded reaches 8 ms. Workers Free did not cut off any request or run at these levels (2,000 requests, 54 runs, up to 79 ms for a link activation). Options if it ever does: fewer D1 round trips per procedure (one batch for session, membership and report), a session cache per isolate, or the paid plan's CPU limits, which the plan rules out without asking the user. **Open for the user** (plan, stage 10: "the CPU thresholds hold").

### CPU, second pass (13 Nov, after the first measurement)

Goal: make "the CPU thresholds hold" true without the paid plan and without changing the threshold (spike 3: warm p95 under 8 ms, warm = third or later request of that procedure in one isolate). Authorization is still decided on every request, and the domain package stays pure. No new dependencies.

**Profile first.** `apps/api/scripts/cpu-bench.ts` (launcher `cpu-bench.mjs`) serves the real `worker.ts` from Node on a model of D1 (Node's SQLite). It records the CPU of each request minus the time inside SQLite, plus the D1 round trips, and it can run under `--cpu-prof`. `live-run.mjs` drives it. Top costs before the changes:

1. **Building the API on every request:** three RPC servers and their dispose took about half of our own CPU. The RPC server cannot be shared across requests in Workers (I/O context), but only the one the route needs has to be built.
2. **D1 round trips:** on Cloudflare the CPU grows by about 1 ms per round trip, which is not visible locally. Reading a revision section took 8 trips, saving one 8, sharing one 7 to 10, publishing 20 or more.
3. **Rebuilt objects:** the repository layers and `wrapRepository` were rebuilt per request and per `yield* store`.
4. **Redaction folding:** a Unicode regex test and `normalize` on every character, about 0.7 ms per 6 KB section.
5. **The Effect runtime and Schema encoding:** a fixed cost of each procedure. Not changed.

**Changes** (identical behaviour; each new repository read is checked against the separate reads it replaces by the shared repository contract, on memory and on D1):

- `makeApp` builds only the handler the route needs. The layers are kept per isolate and rebuilt if `env.DB` or the configuration changes. `store` memoizes the wrapped repository.
- Batched reads, each one D1 round trip: `readReportParts` (report, members, rounds, reviews, revisions), `getDraftWithSections`, `getDraftOutline` (section sizes and "not applicable" computed in SQL), `getWorkingCopyWithSection`, `inboxPage`, and `getPendingReview` as one batch. Round trips now, measured locally: reading a revision section 3, saving one 0 to 4, reading a draft section 3, sharing one 4, the outlines 4, publishing 9 to 11.
- An ASCII fast path in the redaction fold. A test compares it with the old fold over every ASCII character in context and by a property test. 6 KB section: 0.7 to 0.24 ms.
- Measurement only: on a test stage with invocation logs (`REQUEST_SEQUENCE=1`, never set on the pilot, checked by a test), answers carry `x-isolate` and `x-seq` and the pass summary carries both, so warm and cold can be told apart.

Locally, our own CPU per request is now 0.6 to 0.8 ms at p50 and 1.5 to 2 ms at p95 for the section reads and saves, and 1.6 / 5.5 ms for sharing a section.

**Measured on Cloudflare**, on test environment `test_s10c` (pilot stack, `--fast --invocation-logs`), created at 15:02 UTC and destroyed at 15:50 UTC. Afterwards the account lists no test Worker and no test database, and the grants file is gone.

- Run 1 used the first changes (lazy handlers, per-isolate layers, `readReportParts`): live-run pilot plus load with 6 reports, 1,241 requests, 5 isolates.
- Run 2 used all the changes, after a redeploy: load with 6 reports, 992 requests, 1 isolate.

Every outcome was `ok` and none was `exceededCpu`. All values are in ms. "Warm" means `x-seq` at least 3 and at least the third call of that procedure in the isolate.

| Procedure | before (all requests, p50 / p95) | run 1 warm p50 / p95 / max | run 2 warm p50 / p95 / max (n) |
| --- | --- | --- | --- |
| `GetRevisionSection` | 8 / 12 | 3 / 6 / 14 | 5 / 9 / 20 (358) |
| `SaveSection` | 7 / 12 | 4 / 7 / 27 | 5 / 9 / 23 (237) |
| `GetDraftSection` | 7 / 10 | 4 / 7 / 9 | 5 / 8 / 18 (118) |
| `GetWorkingCopySection` | 7 / 10 | 4 / 7 / 8 | 5 / 9 / 39 (57) |
| `ShareSection` | 11 / 17 | 7 / 13 / 54 | 7 / 15 / 83 (58) |
| `GetRevisionOutline` | 10 / 14 | 5 / 9 / 10 | 5 / 9 / 18 (34) |
| `AddComment` | 8 / 12 | 3 / 5 | 5 / 9 / 9 (10) |
| `GetUnreadCount`, `ListInbox` | 4 / 7 | 3 / 6, 3 / 5 | 4 / 8, 4 / 10 (10 each) |
| `FinishShare`, `SendReview`, `PublishRevision` | 11 / 19, 14 / 23, 12 / 21 | 7 / 9, 7 / 8, 7 / 8 | 8 / 9, 8 / 13, 9 / 13 (4 each) |
| `ListNotifications` | not measured | 7 / 10 (cold, seq 1: 23 to 39) | not called |
| Sign-in, link activation | 30 / 58 | 27 / 36, 33 / 35 | 43 (cold 93) |

The busy notification pass, cron, is always cold. In run 2 every one of the 17 passes ran on a fresh isolate (`seq` 1, a different `isolate` each time). Run 1 had 6 passes at 14 to 26 ms. Run 2 had 17 passes at 12 to 46 ms, with a median of 16 (before: 17 / 28 / 31 with 1 report per run). Locally the pass costs about 7 ms cold and 2 ms warm. So on Cloudflare it pays for the first execution of the bundle's code (Effect, the RPC and pass code) on every run.

**Result: the threshold is still not met.**

- The changes roughly halve the CPU of the hot procedures: section reads went from 7–8 ms to 3–5 ms at p50.
- Warm p95 is under 8 ms in run 1 for every section read and save. In run 2 it is 8 to 9 ms for the same procedures.
- `ShareSection` (13 to 15) and the rare write procedures (up to 13) stay above 8 ms in both runs.
- The two runs differ by 1 to 2 ms on the same procedures with fewer round trips in run 2. That is variation between Cloudflare machines and isolates, and it is as large as the margin to the threshold.

I stopped optimizing at this point, as the stage instructions require.

**Where the remaining cost goes**, for a warm section read at 5 ms on Cloudflare:

- About 0.7 ms is our own code, measured locally: Effect runtime, session check, membership and deadline rules, Schema encoding.
- Each of the 3 D1 round trips costs about 1 ms.
- The rest is fixed work of the runtime per request.

For `ShareSection` the extra cost is its 4 round trips and the redaction scan of the shared section. For the pass it is the cold start on every cron run.

What could still reduce the cost, none of it bounded within this stage:

- one round trip for session, membership and report together (an SQL rewrite of the authorization reads);
- a per-isolate session cache, which the stage rules forbid because it would cache authorization;
- the pass on a warm isolate, which cron does not offer;
- the paid plan.

**Open for the user.**

