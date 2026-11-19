# Operating Quoroom

How to start and run a Quoroom deployment with real reports, once it is deployed ([`hosting.md`](hosting.md)). The commands use the MSF pilot on Cloudflare (stage `pilot`) as the example; on another host, use its `--env` and its deploy or start command from the hosting guide.

## The data rule

A deployment in use holds real reports. **Nobody reads or copies its data**: not the operator and not a developer. In practice:

- No SQL against its database (`wrangler d1 execute`, `orange d1 execute` or a dashboard console), no export of it, no copy on a laptop, no screenshots of its screens.
- Problems are reproduced with invented data on a test environment or on a local host (see *When something fails*). Fixtures, tests, logs and screenshots in the repository stay synthetic.
- The operator can technically read the database, so as few people as possible have access to the hosting account.
- The only copy of the content outside the database is what authors download themselves (see *Export*).

## 1. The first account

The operator gives one person People, Theme and Templates, with a one-time link:

```sh
pnpm grant-admin --env pilot --email <email> --name "<name>" --origin https://pilot.<subdomain>.workers.dev
pnpm cloudflare:deploy pilot        # imports .local/grants-pilot.sql
```

- Hand the printed link to that person directly. It is valid for 72 hours and works once; the person opens it and chooses their own password.
- An expired or lost link: run the same command again and deploy, for a fresh link.
- A forgotten password: `pnpm grant-admin --env pilot --email <email> --reset`, then deploy. Once the deployment runs, someone with People issues resets in the app instead (**People**, *Issue reset link*). A reset ends all of that person's sessions.

## 2. Theme and units

Signed in, that person:

1. Opens **Theme**: organisation name, logo, primary, accent, text and background colours, a heading font and a body font, and the PDF header and footer (also a different one for the cover page) with the tokens `{page}`, `{pages}`, `{case}` and `{title}`. The screen shows an app page and a sample PDF, and refuses colours whose text would be hard to read. An organisation's logo is uploaded here by its own people; it is never part of the repository.
2. Opens **People**, creates each unit (*New unit*: a name and a short code), and adds people (*Add person*: e-mail, name, a unit to write reports in, and any of People, Theme and Templates). Everyone is listed in a folder per unit, with a tick per permission that saves at once; the unit's reviewers are shown greyed. They give themselves *Reports in this unit* too. For an e-mail with no account yet, the screen shows a one-time activation link to hand over; Quoroom sends no e-mail. Somebody active always keeps People.

A saved theme shows at once for whoever saved it; other people see it the next time they open the app, within a minute (the browser keeps the theme for 30 seconds).

Authors then open **Reports**, *Reviewers and committees*, to invite co-authors, register reviewers (name, e-mail) and group them into committees. Each new person gets an activation link from whoever invited them.

## 3. The pilot script

The same steps are the automated rehearsal and the walkthrough with the first users. Run them once with invented people before real use starts.

1. The operator gives A People, Theme and Templates. A activates, sets the theme, creates a unit in **People**, and gives *Reports in this unit* to themselves and to B.
2. A registers reviewers R1 and R2 in **Reports**, *Reviewers and committees*, and adds them to a committee. B, R1 and R2 activate their accounts from their links.
3. A opens **Reports**, creates a case file and an *Intake and initial assessment* report (Draft 0), and adds B as co-author. A and B each start a working copy and see that the other is drafting.
4. A fills in some sections, adds a table and an image, marks one section *not applicable*, adds an allegation, and shares Draft 1. B, who added another allegation and changed one of the same fields, shares next: both allegations are kept, B chooses for the one field, comments on Draft 1, and gets Draft 2.
5. A opens **People and names**, accepts name suggestions, adds an alias, marks the image safe to share, checks the redacted view, and chooses *share and publish*: Draft 3 becomes Revision 1, with a deadline. R1 and R2 see it in their inbox on **Home**.
6. R1, on a phone, selects a phrase and comments on it, comments on a section for the whole committee, and requests changes. R2 sees the shared comment, not the other one, and approves. A and B are told about R1's review.
7. A answers the comments, shares Draft 4 and publishes Revision 2. Both reviewers are asked again; R2's approval of Revision 1 stays as history and no longer counts.
8. Reminders reach whoever has not decided. R1 and R2 approve Revision 2; the round is decided and the authors are told.
9. A starts the conclusion. Only the conclusion section can be edited now. A writes it, shares Draft 5 and publishes it as the closing Revision 3. R1 and R2 approve it, and the report is archived.
10. A opens **Downloads** and downloads everything, and the approval record. The **Status grid** and the **Audit log** tell the whole story.
11. In short: an *Investigation report*, archived on approval; a report whose deadline passes with one reviewer silent, decided by the deadline and answered with another revision; and a report on a template published from **Templates** (a copy of the intake whose committee decides by majority, with an observer who comments but cannot vote and a chair who reads the original text).

`pnpm rehearsal` runs the script in Chromium with seven invented people, through the web UI only, the reviewers at phone width. It takes about 25 minutes, mostly waiting for reminders and a deadline, and needs a fresh target with short reminder timings whose first account, A (`alma.ortega@example.org`), was just granted. It refuses any address that is not local or a Cloudflare test environment.

```sh
# A Cloudflare test environment:
pnpm -s grant-admin --env test-<name> --email alma.ortega@example.org --name "Alma Ortega" \
  --origin https://quoroom-test-<name>.<subdomain>.workers.dev > /tmp/admin-link.txt
pnpm test-env:up test_<name> --fast
pnpm rehearsal https://quoroom-test-<name>.<subdomain>.workers.dev --admin-link-file /tmp/admin-link.txt
pnpm test-env:down test_<name>

# OpenOrange on this machine (delete .local/openorange/.open-orange first):
pnpm -s grant-admin --env openorange --email alma.ortega@example.org --name "Alma Ortega" > /tmp/admin-link.txt
pnpm openorange dev --fast
pnpm rehearsal http://127.0.0.1:8787 --admin-link-file /tmp/admin-link.txt

# workerd (move .local/workerd-data-pilot/ aside first), with a tick secret instead of a cron:
pnpm -s grant-admin --env workerd --email alma.ortega@example.org --name "Alma Ortega" > /tmp/admin-link.txt
TICK_SECRET=$(cat ~/.quoroom-tick-secret) NOTIFY_FIRST_REMINDER_MINUTES=10 NOTIFY_FINAL_REMINDER_MINUTES=3 \
  pnpm workerd --mode pilot
pnpm rehearsal http://127.0.0.1:8787 --admin-link-file /tmp/admin-link.txt --tick-secret-file ~/.quoroom-tick-secret
```

It stops at the first step that fails and keeps a screenshot of what each person saw (in `/tmp/quoroom-rehearsal`, or `E2E_SHOTS`). Delete `/tmp/admin-link.txt` afterwards.

## 4. Backups

- **Cloudflare:** D1 Time Travel restores the database to any minute of the last 7 days on the free plan. Nothing has to be set up, and nothing is copied out of Cloudflare. The commands use Wrangler, Cloudflare's own CLI, with its own login on the same account:
  ```sh
  pnpm dlx wrangler@4.161.0 login
  pnpm dlx wrangler@4.161.0 d1 list                         # find the database's name
  pnpm dlx wrangler@4.161.0 d1 time-travel info <database>  # the current bookmark; note it before a risky change
  pnpm dlx wrangler@4.161.0 d1 time-travel restore <database> --timestamp=<RFC 3339 time>
  ```
- **OpenOrange:** the database is a Rivet Actor on the cluster; back it up with the tools of that cluster ([Rivet's documentation](https://rivet.dev/docs)). This repository has no backup step for it.
- **Your own server:** stop `workerd` and copy `.local/workerd-data-pilot/` to storage the organisation controls.

A restore replaces the whole database with its state at that time: everything written after it is lost, for every report. Tell the users first, and restore only after a fault that damaged data, never to undo one person's edit (drafts, revisions and the audit log already keep every version).

## 5. Export: authors' own downloads

There is no export of the database. Each report's authors keep their own copy: on **Downloads** (from the report), *Download all* builds one zip in their browser with every draft and revision as PDF, original and redacted, and the approval record. If the zip would be too large, they download the files one at a time. Reviewers can download the revisions they were sent, in the view they read. PDFs are made from the stored versions each time; nothing is stored as a PDF.

At the end, the authors download what they need, then the operator deletes the deployment (`pnpm cloudflare:destroy pilot` on Cloudflare), which deletes its database.

## 6. When something fails

**Look without reading data.**

- `pnpm smoke <address>` checks the app, the health route and that the API refuses requests without a session. It reads no data.
- The Worker's logs keep errors and the counts of each notification pass, never request bodies or report text (checked by searching a test environment's logs for invented text, see [`decisions.md`](decisions.md), "Logs and CPU"). On Cloudflare, read them in the dashboard: *Workers & Pages*, the Worker, *Logs*. New kinds of errors also arrive by e-mail if the alerts stack is deployed ([`hosting.md`](hosting.md)).
- Usage: on Cloudflare, *Workers & Pages* and *D1* in the dashboard show requests, CPU and rows against the free plan's daily limits. When a limit is reached the Worker stops until 00:00 UTC.

**Reproduce with invented data**, never with real data: run the rehearsal above on a test environment or a local host. The whole browser test (every screen, the pilot path, a sweep of every route at phone and desktop width) runs locally on `workerd` and needs Chromium (`/usr/bin/chromium`, or set `E2E_CHROMIUM`):

```sh
pnpm --filter @quoroom/e2e e2e
```

**Roll back the code.** Migrations only ever add ([`architecture.md`](architecture.md)), so an earlier commit runs on the current database:

```sh
git switch --detach <last good commit>
pnpm install
pnpm cloudflare:plan pilot     # expect an update of the Worker only, nothing replaced or deleted
pnpm cloudflare:deploy pilot
git switch -                   # back to the branch, then fix and deploy again
```

**Roll back data** only from a backup (section 4), after a fault that damaged data.
