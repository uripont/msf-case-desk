# Running a pilot

How to start and run a Quoroom pilot with real reports, on the pilot stack ([`self-hosting.md`](self-hosting.md), section B) or on `workerd` in pilot mode (section A). The guides for the people who use the app come separately.

## The data rule

A pilot holds real reports. **Nobody reads or copies pilot data**: not the operator, not a developer, not an agent. In practice:

- No SQL against the pilot database (`wrangler d1 execute` or the dashboard's console), no export of it, no copy on a laptop, no screenshots of its screens.
- Problems are reproduced with invented data on a test environment or on `workerd` (see *When something fails*). Fixtures, tests, logs and screenshots in the repository stay synthetic.
- The operator can technically read the database, so as few people as possible have access to the Cloudflare account.
- The only copy of the content outside the database is what authors download themselves (see *Export*).

## 1. The first administrator

The operator grants one person the administrator and template editor capabilities, with a one-time link:

```sh
pnpm grant-admin --env pilot --email <email> --name "<name>" --origin https://pilot.<subdomain>.workers.dev
pnpm pilot:deploy        # imports .local/grants-pilot.sql
```

- Hand the printed link to that person directly. It is valid for 72 hours and works once; the person opens it and chooses their own password.
- An expired or lost link: run the same command again and deploy, for a fresh link.
- A forgotten password: `pnpm grant-admin --env pilot --email <email> --reset`, then deploy. Once the pilot runs, an administrator issues resets in the app instead (*Administration*, *Issue reset link*). A reset ends all of that person's sessions.

On `workerd` use `--env workerd` (the link points at `http://127.0.0.1:8787` unless you pass `--origin`) and restart `pnpm workerd --mode pilot` instead of deploying. `workerd` sends no notification by itself: start it with `TICK_SECRET` and add the host cron of [`self-hosting.md`](self-hosting.md) (*Notifications*), or review requests, reminders and deadlines are only noticed when someone opens the report.

## 2. Theme and units

Signed in, the administrator:

1. Opens **Theme**: organisation name, logo, primary, accent, text and background colours, a heading font and a body font, and the PDF header and footer (also a different one for the cover page) with the tokens `{page}`, `{pages}`, `{case}` and `{title}`. The screen shows an app page and a sample PDF, and refuses colours whose text would be hard to read. An organisation's logo is uploaded here by its own administrator; it is never part of the repository.
2. Opens **Administration**, creates each unit (a name and a short code), and gives capabilities by e-mail: *Author in a unit* (for that unit), *Template editor* or *Administrator*. The administrator gives *Author* to themselves too. For an e-mail with no account yet, the screen shows a one-time activation link to hand over; Quoroom sends no e-mail.

A saved theme shows at once for the administrator; other people see it the next time they open the app, within a minute (the browser keeps the theme for 30 seconds).

Authors then open **My unit** to invite co-authors, register reviewers (name, e-mail, phone number) and group them into committees. Each new person gets an activation link from whoever invited them.

## 3. The pilot script

The same steps are the automated end-to-end test and the walkthrough with the first users. Run them once on a test environment with invented people before the real pilot starts.

1. The operator grants administrator A. A activates, sets the theme, creates a unit, and gives the author capability in it to themselves and to B.
2. A registers reviewers R1 and R2 in **My unit** and adds them to a committee. B, R1 and R2 activate their accounts from their links.
3. A opens **Reports**, creates a case file and an *Intake and initial assessment* report (Draft 0), and adds B as co-author. A and B each start a working copy and see that the other is drafting.
4. A fills in some sections, adds a table and an image, marks one section *not applicable*, adds an allegation, and shares Draft 1. B, who added another allegation and changed one of the same fields, shares next: both allegations are kept, B chooses for the one field, comments on Draft 1, and gets Draft 2.
5. A opens **People and names**, accepts name suggestions, adds an alias, marks the image safe to share, checks the redacted view, and chooses *share and publish*: Draft 3 becomes Revision 1, with a deadline. R1 and R2 see it in their **Inbox**; A uses *Send on WhatsApp* for R1 (shown for a reviewer who gave a number and WhatsApp consent).
6. R1, on a phone, selects a phrase and comments on it, comments on a section for the whole committee, and requests changes. R2 sees the shared comment, not the other one, and approves. A and B are told about R1's review.
7. A answers the comments, shares Draft 4 and publishes Revision 2. Both reviewers are asked again; R2's approval of Revision 1 stays as history and no longer counts.
8. Reminders reach whoever has not decided. R1 and R2 approve Revision 2; the round is decided and the authors are told.
9. A starts the conclusion. Only the conclusion section can be edited now. A writes it, shares Draft 5 and publishes it as the closing Revision 3. R1 and R2 approve it, and the report is archived.
10. A opens **Downloads** and downloads everything, and the approval record. The **Status grid** and the **Audit log** tell the whole story.
11. In short: an *Investigation report*, archived on approval; a report whose deadline passes with one reviewer silent, decided by the deadline and answered with another revision; and a report on a template published from **Templates** (a copy of the intake whose committee decides by majority, with an observer who comments but cannot vote and a chair who reads the original text).

The script is also a browser rehearsal with seven invented people, through the web UI only, the reviewers at phone width. It takes about 15 minutes, mostly waiting for a reminder and a deadline, and needs a fresh target whose first administrator was just granted (on `workerd`, stop it and move `.local/workerd-data-pilot/` aside first):

```sh
# On a test environment (see *When something fails*), after test-env:up --fast:
pnpm rehearsal https://test-<name>-pilot.<subdomain>.workers.dev --admin-link-file /tmp/admin-link.txt
# On workerd, with short reminder timings and a tick secret instead of a cron:
pnpm -s grant-admin --env workerd --email admin@example.org --name "Admin Example" > /tmp/admin-link.txt
TICK_SECRET=$(cat ~/.quoroom-tick-secret) NOTIFY_FIRST_REMINDER_MINUTES=10 NOTIFY_FINAL_REMINDER_MINUTES=3 \
  pnpm workerd --mode pilot
pnpm rehearsal http://127.0.0.1:8787 --admin-link-file /tmp/admin-link.txt --tick-secret-file ~/.quoroom-tick-secret
```

It stops at the first step that fails and keeps a screenshot of what each person saw (in `/tmp/quoroom-rehearsal`, or `E2E_SHOTS`).

## 4. Backup: D1 Time Travel

On Cloudflare the pilot database has D1 Time Travel: it can be restored to any minute of the last 7 days on the free plan. Nothing has to be set up, and nothing is copied out of Cloudflare.

The commands use Wrangler, Cloudflare's own CLI, which is not a dependency of this repository, with its own login on the same account:

```sh
pnpm dlx wrangler@4.161.0 login
pnpm dlx wrangler@4.161.0 d1 list                         # find the pilot database's name
pnpm dlx wrangler@4.161.0 d1 time-travel info <database>  # the current bookmark; note it before a risky change
pnpm dlx wrangler@4.161.0 d1 time-travel restore <database> --timestamp=<RFC 3339 time>
```

A restore replaces the whole database with its state at that time: everything written after it is lost, for every report. Tell the users first, and restore only after a fault that damaged data, never to undo one person's edit (drafts, revisions and the audit log already keep every version).

On `workerd`, back up by stopping it and copying `.local/workerd-data-pilot/` to storage the organisation controls.

## 5. Export: authors' own downloads

There is no export of the database. Each report's authors keep their own copy: on **Downloads** (from the report), *Download all* builds one zip in their browser with every draft and revision as PDF, original and redacted, and the approval record. If the zip would be too large, they download the files one at a time. Reviewers can download the revisions they were sent, in the view they read. PDFs are made from the stored versions each time; nothing is stored as a PDF.

At the end of the pilot, the authors download what they need, then the operator runs `pnpm pilot:destroy`, which deletes the Worker and its database.

## 6. When something fails

**Look without reading data.**

- `pnpm smoke https://pilot.<subdomain>.workers.dev` checks the app, the health route and that the API refuses requests without a session. It reads no data.
- The Worker's logs keep errors and the counts of each notification pass, never request bodies or report text (checked by searching a test environment's logs for invented text, see [`decisions.md`](decisions.md), "Logs and CPU"). Read them in the dashboard: *Workers & Pages*, `pilot`, *Logs*. New kinds of errors also arrive by e-mail if the alerts stack is deployed ([`self-hosting.md`](self-hosting.md)).
- Usage: *Workers & Pages* and *D1* in the dashboard show requests, CPU and rows against the free plan's daily limits. When a limit is reached the Worker stops until 00:00 UTC.

**Reproduce with invented data**, never with pilot data.

On `workerd`, the whole browser test (every screen, the pilot path, a sweep of every route at phone and desktop width) runs locally. It needs Chromium (`/usr/bin/chromium`, or set `E2E_CHROMIUM`):

```sh
pnpm --filter @case-desk/e2e e2e
```

On a test environment of the pilot stack (real Cloudflare, short reminder timings):

```sh
pnpm -s grant-admin --env test-<name> --email admin@example.org --name "Admin Example" \
  --origin https://test-<name>-pilot.<subdomain>.workers.dev > /tmp/admin-link.txt
pnpm test-env:up test_<name> --fast
pnpm rehearsal https://test-<name>-pilot.<subdomain>.workers.dev --admin-link-file /tmp/admin-link.txt
pnpm test-env:down test_<name>
rm /tmp/admin-link.txt
```

The rehearsal drives the pilot script through the web UI with invented people and text. It refuses any address that is not local or a test Worker. Only one test environment at a time, and always destroy it afterwards.

**Roll back the code.** Migrations only ever add (see [`compatibility.md`](compatibility.md)), so an earlier commit runs on the current database:

```sh
git switch --detach <last good commit>
pnpm install
pnpm pilot:plan          # expect an update of the Worker only, nothing replaced or deleted
pnpm pilot:deploy
git switch -              # back to the branch, then fix and deploy again
```

**Roll back data** only with Time Travel (section 4), after a fault that damaged data.
