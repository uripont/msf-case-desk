# Quoroom

A template-based reporting tool where a group reaches a *quorum* on a report without having to meet in a *room*. Authors draft privately and share drafts, a committee reviews each revision in its own time before a deadline, and the report is approved, concluded and archived with its whole history. Think of it as an asynchronous meeting room for any report that needs a committee's sign-off.

It was built at Universitat Pompeu Fabra for Médecins Sans Frontières (MSF), together with MSF's Ethics & Behaviour Unit, its first user, and fits any MSF department or humanitarian organisation with the same kind of reporting. It is open source and runs on Cloudflare, on your own server, or through OpenOrange on a Rivet Engine you run.

https://github.com/user-attachments/assets/44f4dc7b-ae2e-430b-b52f-62d26eb697aa

> All data in this repository, its tests and the demo video is synthetic. No real report, case or person is stored here.

## What it does

Templates, roles and their permissions, units and the look (logo, colours, fonts, PDF header and footer) are data, set in the app. The ethics unit's two report templates ship as built-in templates that a template editor can copy and change.

- **Templates** with sections, numbered subsections, repeated entries, rich text, branching, a cover, contents and a conclusion step, built in a template editor ([`docs/templates.md`](docs/templates.md)).
- **Private drafting.** Each author works on an autosaved working copy and shares it as the next draft. Two drafts shared at once are compared item by item.
- **Names and redaction.** Authors list each person with every spelling of their name; reviewers who should not see names only ever receive the redacted text, produced on the server. Images stay withheld until an author marks them safe.
- **Review rounds.** A revision goes to a committee with a deadline. Reviewers comment on selected text or whole sections and approve, request changes or comment. Requests, reminders and outcomes arrive in an in-app inbox on Home. Sending them by e-mail, WhatsApp or another channel is an integration left to each deployment ([`docs/architecture.md`](docs/architecture.md#notifications-outside-the-app)).
- **Closing.** A round is decided by its approval rule or its deadline. The report ends with a closing revision or on approval and is archived, read-only, with a status grid and an audit log. Any draft or revision downloads as a PDF, made in the browser and never stored.

## Documentation

- [`docs/hosting.md`](docs/hosting.md): hosting Quoroom on Cloudflare, on OpenOrange (AWS, Google Cloud, Azure or your own Rivet Engine) or on your own server, with the first account, secrets and alerts.
- [`docs/development.md`](docs/development.md): getting started on your machine, the scripts, and the tests.
- [`docs/architecture.md`](docs/architecture.md): who Quoroom is for, the stack, how the code is laid out, and how versions share one database.
- [`docs/operating.md`](docs/operating.md): running a deployment with real reports, from the first account to backups and failures, and the pilot script.
- [`docs/templates.md`](docs/templates.md): building a template, and the two built-in ones.
- [`docs/api.md`](docs/api.md): the API contract, procedure by procedure, and the image route.
- [`docs/decisions.md`](docs/decisions.md): decisions and measurements.

## Status

Quoroom was the third and final iteration of a Project Management course project at Universitat Pompeu Fabra (team 101_E), from October to November 2026. Iterations 1 and 2 were **Case Desk**, a triage desk for incoming cases; the git tags `iter1`, `iter2` and `iter3` mark each delivery.

## Licence

MIT. See [LICENSE](LICENSE).
