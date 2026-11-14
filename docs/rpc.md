# RPC contract

The contract lives in `packages/domain/src/api/`, and the `Authentication` middleware in `packages/domain/src/rpc.ts`. There are two groups, at `/api/q/public` and `/api/q/rpc`: `QuoroomPublicRpcs` (no session: sign-in and links) and `QuoroomRpcs` (signed in, behind the same `Authentication` middleware). `procedures.ts` holds the table below as data; a test checks every procedure has exactly one row.

## Rules of the contract

- **One refusal for forbidden and missing.** `NotFound` carries no fields. A report, draft, revision or template the caller may not see answers exactly like one that does not exist.
- **Refusals map one to one** (`refusalToError`, `api/common.ts`) from the three answers of `authorize`: `not_found` is `NotFound`; `not_permitted` is `NotPermitted` with reason `not_permitted`; `read_only` (an archived report refuses every write) is `NotPermitted` with reason `read_only`. A non-member of a report, and anyone asking about a report that does not exist, always gets `NotFound`; `NotPermitted` reaches only someone who already sees the thing (a member without the permission) or, for the capabilities of the deployment (administrator, template editor, author in a unit, operator), a caller without the capability, whether or not the target exists, since `authorize` never looks at it. Reads and writes that call `authorize` declare both errors.
- **Errors.** `NotPermitted` (reason: `not_permitted`, `read_only`), `Conflict` (reason: `stale_save`, `stale_base`, `already_exists`, `duplicate`, `not_latest`, `already_sent`, `share_incomplete`, `changed_meanwhile`), `Validation` (coded `Problem`s from the domain: source, code, path, fixed message, never report text), `DeadlinePassed`, `NotAllowedInState` (a `FlowErrorCode` or `SaveErrorCode`), `StorageUnavailable`, and for the public group `InvalidCredentials`, `Throttled` (retry delay, at most 15 minutes) and `LinkInvalid` (unknown, used and expired links alike). Every procedure declares an error schema; reads cannot fail with `Conflict` or `DeadlinePassed`.
- **Payload size** (CPU, see [`decisions.md`](decisions.md), "Logs and CPU"). One section per save (`SaveSection`), one section per share request (`ShareSection`), then a guarded `FinishShare`. No procedure takes or returns a whole document: working copies, drafts and revisions are read as an outline and then section by section.
- **Sharing on a stale base** does not fail: `FinishShare` answers `ShareOutcome` with `kind: 'stale_base'` and the `Comparison` (conflicts of `compareDrafts`, each side holding only the item). The author resolves with `ResolveMerge` (choices by conflict key) and shares again. "Share and publish" is `FinishShare` with `publish` set.
- **Reviewers never choose the view.** No reviewer request has a `view`. `GetRevisionSection` answers one `content` in the view the server chose from the role (stored redacted content for `redacted`, the original for `full`). Reviewer responses carry no working copy, draft, people list, alias, save counter or redacted twin; a structural test enforces this on the schemas. A reviewer's comment has one `body`, already the right version; only the authors' view has `redactedBody`.
- **Comments** anchor to a section or to a selection (`from`, `to` and the `quoted` text, in the view its author read). Visibility is `authors` (default) or `committee`, chosen on a pending comment and fixed when the review is sent. A comment of a `full` reviewer shared with the committee reaches a `redacted` reader as a `SectionNoteCommentView`: anchor `{ kind: 'section_note', sectionId, quoted? }` with the quoted text derived from the original text the selection was made in (located by `from`, `to` and `quoted`), widened to whole names and words, and only then redacted (`redactedQuote`), so a selection cut inside a name never shows a fragment of it; a quote that cannot be located is left out. Never positions in a text the reader does not have (D14). The `caseReference` of the inbox, the pending reviews and the outline is the redacted twin stored with the draft at share time for a `redacted` role (the original for `full`), like `caseTitle`; `ListReviewerComments` answers a union of that and `AnchoredCommentView`. Comments shared with the committee name their author (display name; the server passes it through the revision's redaction for a redacted reader); no other reviewer response names anyone.
- **Per-address sign-in limits by runtime (D13, D20).** `cf-connecting-ip` is trusted only on Cloudflare. On workerd the deployment names a trusted proxy header (`TRUSTED_PROXY_HEADER`); without one every caller shares a single `self-hosted` bucket, so the per-address limit holds only together with the per-email limit. Old `sign_in_attempts` are pruned (at most 50 per sign-in). A successful sign-in clears the failures of that email.
- **Cleanup for the notification pass.** `cleanupStale` (core.ts) deletes images no draft references and staged shares abandoned for more than 24 hours, at most 50 of each per call. Retried identical chunk uploads are accepted. A malformed percent-encoding in an image path answers 400.
- **Invitations and additions disclose nothing (D13).** `InviteToUnit` and `AddReviewer` answer one shape for a new account and for an email that already has one: the ID and what the caller supplied, and an activation `link` only for a new account. No name, phone, email or state of an existing account is returned.
- **Problems carry codes and positions.** The people list's problems (`duplicate-id`, `invalid-label`, `duplicate-label`, `label-matches-alias`) have fixed messages and a path of position and field, never a label, name or alias.
- **Publishing and closing.** `PublishRevision` and `FinishShare` with `publish` refuse a draft that is not the latest shared one (`Conflict` `not_latest`, from the flow error `not_latest`). While the report is `concluding`, sharing calls `checkClosingDraft(template, state, base, draft)` with the latest revision as base and refuses a draft whose sections other than the conclusion differ from it (compared canonically); the handler answers `Validation` (source `save`, code `other_sections_changed`, the section IDs as paths). A review (`SendReview`) is refused (`NotAllowedInState`, code `round_not_open`) unless its `revision` is the open round's.
- **Name suggestions run in the browser.** `suggestNames` is a pure function of the working copy's content and people list, which only an author has, so there is no procedure for it. This avoids a request that would carry the whole document and costs the Worker no CPU. The server never needs suggestions.
- **Client-side PDFs.** `GetDownloads` lists the versions an author may take out, `GetDraftSection` / `GetRevisionSection` supply the content, and `GetApprovalRecordData` supplies the flow and events for the approval record. Nothing is stored.
- **Deadlines** are `{ at, timeZone }`: UTC milliseconds with the author's IANA zone.
- **`ShareSection`/`FinishShare` IDs** (`shareId`) are chosen by the browser and are the same for every request of one share.

## `/api/images`

Not part of the RPC (`images-route.ts`). `POST /api/images?<ImageChunkQuery>` takes the raw bytes of one chunk (at most 700 KB, `application/octet-stream`) and answers `ImageChunkResult`; the last chunk completes the image and returns its `ImageMeta`. `GET /api/images/<id>/<index>?<ImageReadQuery>` answers `ImageChunkRead`, the stored base64 text of one chunk, only if the image is referenced by the version named in the query that the caller may read (and, for a `redacted` role, marked safe in that version's draft **and still marked safe in the latest draft**: a published revision is immutable, but an image the author withdraws in a later draft is no longer served to redacted readers of earlier revisions, who get 404 and the placeholder). The parameters (`report`, and `draft` or `revision` for those contexts) and the caller's permission are checked before the image is looked up, so a missing parameter, an image the version does not reference and an image that does not exist all answer the same 404 `not_found`. Withdrawal is immediate: `MarkImageSafe` with `safe: false` also clears the safe flag of the image in the latest draft (`withdrawImage`), so redacted readers of every published revision get 404 at once, not after the next share. Marking an image safe again takes effect when a draft that carries the mark is shared. A completed image is checked across all its chunks: one that carries metadata (JPEG APP1/APP13/comment, PNG tEXt/zTXt/iTXt/eXIf/tIME) is deleted and refused with `has_metadata` (415); anything that is not a JPEG or PNG is `bad_signature`. Errors are `{ code, message }` with the HTTP status in `IMAGE_ERROR_STATUS`. Limits: 1 MB per image, 1600 px, 20 MB of referenced images per report, uploads refused once the database passes 400 MB.

## Procedures by area

Caller: `public`, `signed_in` (any account, about itself), `admin`, `template_editor`, `unit_author` (author capability in the unit), `report_author` (member of the report's drafting role with the permission that `authorize` checks), `reviewer` (participant of the round in a reviewing role). The `authorize` actions are those of `packages/domain/src/permissions.ts`; the handler runs them on every request.

### session (6)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `SignIn` | public | - | Served at `/api/q/public`, no session. Throttled before hashing (D13): 5 failures per email or 20 per address in 15 minutes, then a wait of 60 s doubling to at most 15 minutes from the last failure; a refused attempt is not counted. The Worker sets the `case_desk_session` cookie; the body is the account, never the token. |
| `InspectLink` | public | - | Unknown, used and expired links all answer `LinkInvalid`. |
| `ConsumeLink` | public | - | One use: sets the password, ends every session of the account, marks the link used (one batch), then signs in with a new cookie. |
| `GetMe` | signed_in | - |  |
| `SignOut` | signed_in | - |  |
| `SetNotificationPreferences` | signed_in | - | D19. Also the only place a phone number and WhatsApp consent of an account are set: by the person, on their own account. |

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
| `ListReviewers` | unit_author | `manage_committees` | The unit's own registry entries: name and phone as the unit typed them, `consentRequested`, `active`. Never `passwordSetAt`, consent state or any other account data. |
| `AddReviewer` | unit_author | `manage_committees` | Echoes what the caller supplied; nothing stored for an existing account (D13). |
| `UpdateReviewer` | unit_author | `manage_committees` | Edits only the unit's entry (name, phone, `whatsappConsent` meaning "consent requested"); never the account's own name, phone or consent. |
| `ListCommittees` | unit_author | `manage_committees` |  |
| `CreateCommittee` | unit_author | `manage_committees` |  |
| `UpdateCommittee` | unit_author | `manage_committees` | Member changes as `addMemberIds` and `removeMemberIds` on the stored list. |

### templates (9)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListTemplates` | template_editor | `edit_template` | One page per call: payload `{offset?, limit?}` (at most 100), answer `TemplatesPage` with `next`. `name` is the published version's name; `draftName` and `draftVersion` describe the draft. |
| `ListPublishedTemplates` | unit_author | `create_report` | Any author capability. |
| `GetTemplateVersion` | template_editor | `preview_template`, `read_template_version` | Template editors read any version (`preview_template`). Authors of a report that uses the version, and reviewers for the version of a revision sent to them, read it with `read_template_version` on that report (`reportId`, and `revision` for a reviewer); anyone else gets NotFound. |
| `CreateTemplateDraft` | template_editor | `create_template`, `copy_template` | The new draft is validated before it is stored (`Validation` otherwise). A built-in template can only be copied under a new name, never given a new version. |
| `SaveTemplateDraft` | template_editor | `edit_template` | Guarded by `draftRevision` (the number the editor last read): a different number is `Conflict` `stale_save`. Each save increases it. |
| `PublishTemplateVersion` | template_editor | `publish_template` | Takes the `draftRevision` the editor showed the diff for; refused (`Conflict` `stale_save`) if the draft changed. Refused with `template_retired` while the template is retired. |
| `RetireTemplate` | template_editor | `retire_template` |  |
| `RestoreTemplate` | template_editor | `retire_template` | Un-retires: the newest retired version is published again. Reports are unaffected by retiring and restoring. |
| `DiscardTemplateDraft` | template_editor | `edit_template` | Deletes a draft that was never published, also one that cannot be opened. |

### theme (2)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetTheme` | signed_in | - |  |
| `UpdateTheme` | admin | `set_theme` | Refuses unreadable contrast, unknown tokens and an incomplete logo. The logo is read with `context=theme` by any signed-in account. |

### reports (7)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListCaseFiles` | unit_author | `create_report` |  |
| `UpdateCaseFile` | report_author | `view_report` | Only members of a report on the case file (guarded in one batch); every report of the case file gets an audit row. Anyone else: `NotFound`. |
| `CreateReport` | unit_author | `create_report` |  |
| `ListReports` | report_author | `view_report` | Only reports where the caller is a member. A constant number of queries: at most 40 reports, one read of their templates, and at most 2 overdue rounds settled per call (the others show their stored state until opened or settled by the scheduled pass). |
| `GetReport` | report_author | `view_report` |  |
| `AddCoAuthor` | report_author | `add_co_author` | By `accountId`, from the existing authors of the report's unit. Creates no account and grants nothing; an unknown, non-author or inactive ID gets one `Validation` refusal (`not_a_unit_author`). checkNewAuthor: not a reviewer in an open round. |
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
| `ShareSection` | report_author | `share_draft` | Every section of one share is redacted with one people list, fixed by the first staged section (`peopleHash`). If the people list changes before `FinishShare`, the finish is refused (`Conflict` `changed_meanwhile`, or `Validation` `redaction_not_confirmed` when a confirmation hash was sent). |
| `FinishShare` | report_author | `share_draft`, `publish_revision` | publish_revision only when `publish` is set. `redactionHash` (the SHA-256 of `<staged redacted hashes of the sections joined with ','>|<SHA-256 of the people list>|<case hash>`, the pieces returned by `ShareSection.redactedHash`, `ShareSection.peopleHash` and `ShareSection.caseHash`) confirms the redaction preview; the server rechecks it and writes the confirmation in the same batch as the publish, which is guarded on it. The case hash is the SHA-256 of the canonical JSON of the case title and reference redacted with the people list (`redactedCaseOf`); the server reads the case file at staging (`ShareSection`), recomputes it in `FinishShare`, and the draft insert is guarded on the case file still having that title and reference (`case_changed`), so a retitled case file is never the share the author saw. `ShareSection` and `FinishShare` refuse a people list with problems (`peopleListProblems`) with `Validation`, whatever way it got into the working copy. **The hash must be the one the browser computed from the staged redacted content it showed the author**, never one read back from the server's own header (`GetHistory.redactedHash`): the preview check is the confirmation. |
| `PreviewMerge` | report_author | `share_draft` |  |
| `ResolveMerge` | report_author | `save_section` |  |

### history (4)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetHistory` | report_author | `read_draft` |  |
| `GetDraftOutline` | report_author | `read_draft` | Records the draft as read. Also the case title and reference as stored redacted for the draft. |
| `GetDraftSection` | report_author | `read_draft` |  |
| `CompareDrafts` | report_author | `read_draft` |  |

### redaction (3)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ConfirmRedaction` | report_author | `publish_revision` | `redactedHash` must be computed by the caller from the staged redacted content shown to the author (the redacted sections of `GetDraftSection`, the people list, and `GetDraftOutline.redactedCaseTitle` / `redactedCaseReference`), in the same format as `FinishShare.redactionHash`; echoing `GetHistory.redactedHash` skips the preview and is not a valid flow. No publish path may accept a confirmation the browser did not compute from the preview. |
| `ListImages` | report_author | `read_working_copy` |  |
| `MarkImageSafe` | report_author | `save_section` |  |

### publishing (7)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetPublishChoices` | report_author | `publish_revision` |  |
| `PublishRevision` | report_author | `publish_revision` |  |
| `GetRound` | report_author | `read_grid` |  |
| `ExtendDeadline` | report_author | `extend_deadline` |  |
| `RemoveReviewer` | report_author | `remove_reviewer` | When the removal makes the rule met, the round is decided in the same batch. |
| `StartConclusion` | report_author | `start_conclusion` |  |
| `ArchiveReport` | report_author | `publish_revision` | The `archive` event of report-flow.ts. |

### reviewer (11)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListInbox` | reviewer | - | Rounds the caller participates in, one page per call: payload `{offset?, limit?}`, answer `InboxPage` with `next` (the offset of the following page). |
| `ListPendingReviews` | reviewer | `write_comment` |  |
| `GetRevisionOutline` | reviewer | `read_revision` | Records the revision as opened. |
| `GetRevisionSection` | reviewer | `read_revision` | The server picks redacted or full. |
| `ListReviewerComments` | reviewer | `read_comments` | canSeeComment. |
| `AddComment` | reviewer | `write_comment` |  |
| `UpdatePendingComment` | reviewer | `write_comment` |  |
| `DeletePendingComment` | reviewer | `write_comment` |  |
| `GetPendingReview` | reviewer | `write_comment` |  |
| `SavePendingReview` | reviewer | `write_comment` |  |
| `SendReview` | reviewer | `submit_review` | `commentIds` are the pending comments the reviewer saw; any other set is `Conflict` `pending_changed`. |

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
| `ListAuditEvents` | report_author | `read_audit` | Subject `template`: template editor; `theme`: administrator. `kind` filters a report's log on the server before the page is cut. |

### notifications (5)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `ListNotifications` | signed_in | - | Newest first, generic lines only: no case reference, title or content for any role. `before` and `next` are notification cursors (a number): pass `next` as `before` for the older page. |
| `GetUnreadCount` | signed_in | - | The cheap poll. The web app asks at sign-in and every 30 seconds, backing off to 5 minutes when nothing changes, pausing while the tab is hidden and refreshing on focus. |
| `MarkNotificationsRead` | signed_in | - | Up to 100 ids; returns the new unread count. Ids that are not the caller's are ignored. |
| `GetWhatsAppLink` | report_author | `publish_revision` | Needs the reviewer's number and consent. |
| `ListWhatsAppLinks` | report_author | `publish_revision` | Who can get a link; no numbers. |
| `RecordWhatsAppOpened` | report_author | `publish_revision` |  |

### downloads (2)

| Procedure | Caller | `authorize` action | Note |
| --- | --- | --- | --- |
| `GetDownloads` | report_author | `read_draft` |  |
| `GetApprovalRecordData` | report_author | `read_grid` |  |

## `/api/config`

Signed-out and unauthenticated: only `mode` and `theme` with `schemaVersion`, `organisationName`, `colors` and `fonts`. PDF header and footer text is not here; it comes from the session-gated `GetTheme`.
