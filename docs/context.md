# Context

## Who this is for

Case managers and committee members in MSF's ethics and behaviour functions, across all operational centres. The project started with the Ethics & Behaviour Unit, but the problem it addresses is shared: cases wait for a periodic meeting before anyone assesses them.

## The existing platform

MSF's public Integrity Line page (msf.ch/integrity-line) links to a hosted platform run by EQS Group, operated per centre (the one reviewed here is the Geneva Operations Centre instance). From the public front page:

- Reporters can **make a complaint** or **ask a question**.
- They create a personal secure account for follow-up.
- After review, a committee decides the action and a case manager contacts the reporter.
- It is hosted on external servers in Germany.

This was read from the public pages only. Nothing was submitted, and no internal system was accessed.

EQS Group's own product pages go further than the reporter side. They advertise a back office for case handlers with user roles and access control, a revision log for every case and activity, dashboards and charts, routing of cases by predefined risk levels, categories and responsibilities, and collaborative case work. These are vendor claims, not confirmed for MSF's instance, and the public pages do not describe case status stages. The overlap with triage is real, so it has to be settled with the unit rather than assumed.

## Boundaries, to avoid duplicating it

Case Desk stays on the **internal** side of the process.

| Does | Does not |
| --- | --- |
| Assess scope, risk and urgency of a case that has already arrived | Collect complaints or questions from reporters |
| Explain every priority with its reasons | Create reporter accounts or secure reporter messaging |
| Run fast-track, delegated and asynchronous decisions | Replace the committee's authority over outcomes |
| Keep an append-only audit log of decisions | Store reporter identity or free-text testimony |
| Reference a case by identifier | Copy case content out of the Integrity Line |

The integration plan is by reference: a case enters Case Desk with an identifier, the assessed factors, and a link back, never the narrative.

## Movement-wide requirements

These are not built yet. They shape the design from the start.

| Requirement | Why | Where it lands |
| --- | --- | --- |
| Operational centre on every case | Five operational centres run their own processes | In the model today (`OperationalCentre`) |
| Rules owned per centre | Centres may weigh factors differently | Increment 2: rules stored per centre, versioned |
| Roles and visibility per centre | A centre must not see another centre's cases by default | Increment 3, with the audit log |
| Single sign-on | Staff already have identities | After the course |
| Data residency | Case data is sensitive and some centres need a region | Cloudflare regions, or self-hosting on workerd |
| Translation and right-to-left | The Integrity Line is offered in English, French, Spanish, Swahili and Arabic | After the course |

## What the unit should tell us first

- Which back-office features of the Integrity Line do the case managers and the committee use, and which are switched off?
- Where does the assessment live today: in the Integrity Line, in Word or PDF templates, in email, in a spreadsheet?
- Which documents are reviewed and signed off, who may suggest changes, and who may accept them?
- Can the Integrity Line export cases or notify other systems, or does a case have to be entered by hand?

## Open questions for the unit

- Which of these centres should the first pilot cover?
- What identifier format links a case to its Integrity Line record?
- Which factors do the centres already assess, and how?
