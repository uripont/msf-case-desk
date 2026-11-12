# RPC contract (iteration 3)

The contract lives in `packages/domain/src/api/`. `CaseDeskRpcs` (iteration 2, `src/rpc.ts`) is untouched and stays in use until stage 3 switches the apps over. Two new groups sit beside it: `QuoroomPublicRpcs` (no session: sign-in and links) and `QuoroomRpcs` (signed in, behind the same `Authentication` middleware). `procedures.ts` holds the table below as data; a test checks every procedure has exactly one row.

## Rules of the contract

- **One refusal for forbidden and missing.** `NotFound` carries no fields. A report, draft, revision or template the caller may not see answers exactly like one that does not exist.
- **Refusals map one to one** (`refusalToError`, `api/common.ts`) from the three answers of `authorize`: `not_found` is `NotFound`; `not_permitted` is `NotPermitted` with reason `not_permitted`; `read_only` (an archived report refuses every write) is `NotPermitted` with reason `read_only`. A non-member of a report, and anyone asking about a report that does not exist, always gets `NotFound`; `NotPermitted` reaches only someone who already sees the thing (a member without the permission) or, for the capabilities of the deployment (administrator, template editor, author in a unit, operator), a caller without the capability, whether or not the target exists, since `authorize` never looks at it. Reads and writes that call `authorize` declare both errors.
- **Errors.** `NotPermitted` (reason: `not_permitted`, `read_only`), `Conflict` (reason: `stale_save`, `stale_base`, `already_exists`, `duplicate`, `not_latest`, `already_sent`, `share_incomplete`, `changed_meanwhile`), `Validation` (coded `Problem`s from the domain: source, code, path, fixed message, never report text), `DeadlinePassed`, `NotAllowedInState` (a `FlowErrorCode` or `SaveErrorCode`), `StorageUnavailable`, and for the public group `InvalidCredentials`, `Throttled` (retry delay, at most 15 minutes) and `LinkInvalid` (unknown, used and expired links alike). Every procedure declares an error schema; reads cannot fail with `Conflict` or `DeadlinePassed`.
- **Payload size (spike 3).** One section per save (`SaveSection`), one section per share request (`ShareSection`), then a guarded `FinishShare`. No procedure takes or returns a whole document: working copies, drafts and revisions are read as an outline and then section by section.
- **Sharing on a stale base** does not fail: `FinishShare` answers `ShareOutcome` with `kind: 'stale_base'` and the `Comparison` (conflicts of `compareDrafts`, each side holding only the item). The author resolves with `ResolveMerge` (choices by conflict key) and shares again. "Share and publish" is `FinishShare` with `publish` set.
- **Reviewers never choose the view.** No reviewer request has a `view`. `GetRevisionSection` answers one `content` in the view the server chose from the role (stored redacted content for `redacted`, the original for `full`). Reviewer responses carry no working copy, draft, people list, alias, save counter or redacted twin; a structural test enforces this on the schemas. A reviewer's comment has one `body`, already the right version; only the authors' view has `redactedBody`.
- **Comments** anchor to a section or to a selection (`from`, `to` and the `quoted` text, in the view its author read). Visibility is `authors` (default) or `committee`, chosen on a pending comment and fixed when the review is sent. A comment of a `full` reviewer shared with the committee reaches a `redacted` reader as a `SectionNoteCommentView`: anchor `{ kind: 'section_note', sectionId, quoted? }` with the quoted text redacted, never positions in a text the reader does not have (D14); `ListReviewerComments` answers a union of that and `AnchoredCommentView`. Comments shared with the committee name their author (display name; the server passes it through the revision's redaction for a redacted reader); no other reviewer response names anyone.
- **Invitations and additions disclose nothing (D13).** `InviteToUnit` and `AddReviewer` answer one shape for a new account and for an email that already has one: the ID and what the caller supplied, and an activation `link` only for a new account. No name, phone, email or state of an existing account is returned.
- **Problems carry codes and positions.** The people list's problems (`duplicate-id`, `invalid-label`, `duplicate-label`, `label-matches-alias`) have fixed messages and a path of position and field, never a label, name or alias.
- **Publishing and closing.** `PublishRevision` and `FinishShare` with `publish` refuse a draft that is not the latest shared one (`Conflict` `not_latest`, from the flow error `not_latest`). While the report is `concluding`, sharing calls `checkClosingDraft(template, state, base, draft)` with the latest revision as base and refuses a draft whose sections other than the conclusion differ from it (compared canonically); the handler answers `Validation` (source `save`, code `other_sections_changed`, the section IDs as paths). A review (`SendReview`) is refused (`NotAllowedInState`, code `round_not_open`) unless its `revision` is the open round's.
- **Name suggestions run in the browser.** `suggestNames` is a pure function of the working copy's content and people list, which only an author has, so there is no procedure for it. This avoids a request that would carry the whole document and costs the Worker no CPU. The server never needs suggestions.
- **Client-side PDFs.** `GetDownloads` lists the versions an author may take out, `GetDraftSection` / `GetRevisionSection` supply the content, and `GetApprovalRecordData` supplies the flow and events for the approval record. Nothing is stored.
- **Deadlines** are `{ at, timeZone }`: UTC milliseconds with the author's IANA zone.
- **`ShareSection`/`FinishShare` IDs** (`shareId`) are chosen by the browser and are the same for every request of one share.

## `/api/images`

Not part of the RPC (`images-route.ts`). `POST /api/images?<ImageChunkQuery>` takes the raw bytes of one chunk (at most 700 KB, `application/octet-stream`) and answers `ImageChunkResult`; the last chunk completes the image and returns its `ImageMeta`. `GET /api/images/<id>/<index>?<ImageReadQuery>` answers `ImageChunkRead`, the stored base64 text of one chunk, only if the image is referenced by the version named in the query that the caller may read (and, for a `redacted` role, marked safe there). Errors are `{ code, message }` with the HTTP status in `IMAGE_ERROR_STATUS`. Limits: 1 MB per image, 1600 px, 20 MB of referenced images per report, uploads refused once the database passes 400 MB.

## Procedures by area

Caller: `public`, `signed_in` (any account, about itself), `admin`, `template_editor`, `unit_author` (author capability in the unit), `report_author` (member of the report's drafting role with the permission that `authorize` checks), `reviewer` (participant of the round in a reviewing role). The `authorize` actions are those of `packages/domain/src/permissions.ts`; the handler runs them on every request.

### session (6)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `SignIn` | public | - | Throttled before hashing (D13). |
| `InspectLink` | public | - |  |
| `ConsumeLink` | public | - |  |
| `GetMe` | signed_in | - |  |
| `SignOut` | signed_in | - |  |
| `SetNotificationPreferences` | signed_in | - | D19. Authors only matter. |

### accounts (4)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListAccounts` | admin | `manage_grants` |  |
| `IssueReset` | admin | `issue_reset` |  |
| `GrantCapability` | admin | `manage_grants` |  |
| `RevokeCapability` | admin | `manage_grants` |  |

### units (5)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListUnits` | signed_in | - | Administrators all units; others the units they hold a grant in. |
| `CreateUnit` | admin | `manage_units` |  |
| `UpdateUnit` | admin | `manage_units` |  |
| `ListUnitMembers` | unit_author | `invite_to_unit` |  |
| `InviteToUnit` | unit_author | `invite_to_unit` | One shape for new and existing accounts; a link only for a new one (D13). |

### committees (6)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListReviewers` | unit_author | `manage_committees` |  |
| `AddReviewer` | unit_author | `manage_committees` | Echoes what the caller supplied; nothing stored for an existing account (D13). |
| `UpdateReviewer` | unit_author | `manage_committees` |  |
| `ListCommittees` | unit_author | `manage_committees` |  |
| `CreateCommittee` | unit_author | `manage_committees` |  |
| `UpdateCommittee` | unit_author | `manage_committees` |  |

### templates (7)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListTemplates` | template_editor | `edit_template` |  |
| `ListPublishedTemplates` | unit_author | `create_report` | Any author capability. |
| `GetTemplateVersion` | template_editor | `preview_template`, `read_template_version` | Template editors read any version (`preview_template`). Authors of a report that uses the version, and reviewers for the version of a revision sent to them, read it with `read_template_version` on that report (`reportId`, and `revision` for a reviewer); anyone else gets NotFound. |
| `CreateTemplateDraft` | template_editor | `create_template`, `copy_template` |  |
| `SaveTemplateDraft` | template_editor | `edit_template` |  |
| `PublishTemplateVersion` | template_editor | `publish_template` |  |
| `RetireTemplate` | template_editor | `retire_template` |  |

### theme (2)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetTheme` | signed_in | - |  |
| `UpdateTheme` | admin | `set_theme` |  |

### reports (7)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListCaseFiles` | unit_author | `create_report` |  |
| `UpdateCaseFile` | report_author | `view_report` | Authors of a report of the case file. |
| `CreateReport` | unit_author | `create_report` |  |
| `ListReports` | report_author | `view_report` | Only reports where the caller is in the drafting role. |
| `GetReport` | report_author | `view_report` |  |
| `AddCoAuthor` | report_author | `add_co_author` | checkNewAuthor: not a reviewer in an open round. |
| `ListDrafting` | report_author | `read_people` | Author-only fact, polled every 30 seconds. |

### working_copies (6)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `StartWorkingCopy` | report_author | `start_working_copy` |  |
| `GetWorkingCopy` | report_author | `read_working_copy` |  |
| `GetWorkingCopySection` | report_author | `read_working_copy` | Own working copy only. |
| `SaveSection` | report_author | `save_section` | checkSave: conclusion rule. |
| `SavePeople` | report_author | `save_people` |  |
| `GetPeople` | report_author | `read_people` |  |

### sharing (4)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ShareSection` | report_author | `share_draft` |  |
| `FinishShare` | report_author | `share_draft`, `publish_revision` | publish_revision only when `publish` is set. |
| `PreviewMerge` | report_author | `share_draft` |  |
| `ResolveMerge` | report_author | `save_section` |  |

### history (4)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetHistory` | report_author | `read_draft` |  |
| `GetDraftOutline` | report_author | `read_draft` | Records the draft as read. |
| `GetDraftSection` | report_author | `read_draft` |  |
| `CompareDrafts` | report_author | `read_draft` |  |

### redaction (3)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ConfirmRedaction` | report_author | `publish_revision` |  |
| `ListImages` | report_author | `read_working_copy` |  |
| `MarkImageSafe` | report_author | `save_section` |  |

### publishing (7)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetPublishChoices` | report_author | `publish_revision` |  |
| `PublishRevision` | report_author | `publish_revision` |  |
| `GetRound` | report_author | `read_grid` |  |
| `ExtendDeadline` | report_author | `extend_deadline` |  |
| `RemoveReviewer` | report_author | `remove_reviewer` |  |
| `StartConclusion` | report_author | `start_conclusion` |  |
| `ArchiveReport` | report_author | `publish_revision` | The `archive` event of report-flow.ts. |

### reviewer (11)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListInbox` | reviewer | - | Rounds the caller participates in. |
| `ListPendingReviews` | reviewer | `write_comment` |  |
| `GetRevisionOutline` | reviewer | `read_revision` | Records the revision as opened. |
| `GetRevisionSection` | reviewer | `read_revision` | The server picks redacted or full. |
| `ListReviewerComments` | reviewer | `read_comments` | canSeeComment. |
| `AddComment` | reviewer | `write_comment` |  |
| `UpdatePendingComment` | reviewer | `write_comment` |  |
| `DeletePendingComment` | reviewer | `write_comment` |  |
| `GetPendingReview` | reviewer | `write_comment` |  |
| `SavePendingReview` | reviewer | `write_comment` |  |
| `SendReview` | reviewer | `submit_review` |  |

### comments (5)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListDraftComments` | report_author | `read_draft_comments` |  |
| `AddDraftComment` | report_author | `comment_on_draft` |  |
| `ListRevisionComments` | report_author | `read_comments` | Every sent comment, in the view it was written in. |
| `ReplyToComment` | report_author | `reply` |  |
| `ResolveComment` | report_author | `reply` |  |

### grid_audit (2)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetGrid` | report_author | `read_grid` |  |
| `ListAuditEvents` | report_author | `read_audit` | Subject `template`: template editor; `theme`: administrator. |

### notifications (5)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListNotifications` | signed_in | - |  |
| `GetUnreadCount` | signed_in | - |  |
| `MarkNotificationsRead` | signed_in | - |  |
| `GetWhatsAppLink` | report_author | `publish_revision` | Needs the reviewer's number and consent. |
| `RecordWhatsAppOpened` | report_author | `publish_revision` |  |

### downloads (2)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetDownloads` | report_author | `read_draft` |  |
| `GetApprovalRecordData` | report_author | `read_grid` |  |
