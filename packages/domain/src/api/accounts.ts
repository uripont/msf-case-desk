import { Schema } from 'effect'

import { Email } from '../user'
import {
  AccountRef,
  ApiId,
  DisplayName,
  EpochMs,
  LinkToken,
  NewPassword,
  Phone,
} from './common'

// NOTE: Session, accounts, capabilities, units, unit membership, the reviewer
// registry and committees (stage 3). Sign-in and links are in the public
// group: the Worker sets or clears the session cookie itself, and the token
// never appears in a response body.

export const CapabilityName = Schema.Literals([
  'admin',
  'template_editor',
  'author',
])

export const GrantView = Schema.Struct({
  capability: CapabilityName,
  // NOTE: Only for `author`.
  unit: Schema.optionalKey(ApiId),
})

export const ProfileView = Schema.Struct({
  phone: Schema.optionalKey(Phone),
  whatsappConsent: Schema.Boolean,
  // NOTE: D19. Off by default.
  notifyOnApproval: Schema.Boolean,
})

export const MeView = Schema.Struct({
  id: ApiId,
  email: Schema.String,
  name: DisplayName,
  grants: Schema.Array(GrantView),
  profile: ProfileView,
})
export type MeView = typeof MeView.Type

// ---- Links (D13) --------------------------------------------------------------

// NOTE: Where the two iteration 3 RPC groups are served.
export const QUOROOM_RPC_PATH = '/api/q/rpc'
export const QUOROOM_PUBLIC_PATH = '/api/q/public'

// NOTE: Where the app shows a link. The token follows in the fragment, so it
// is never part of a request URL: `/link#<token>`.
export const LINK_PATH = '/link'

export const LinkPurpose = Schema.Literals(['activate', 'reset'])

// NOTE: Returned once, to the person who issued it. The browser puts the
// token in the URL fragment (`#...`); the page POSTs it.
export const ActivationLink = Schema.Struct({
  purpose: LinkPurpose,
  token: LinkToken,
  expiresAt: EpochMs,
})
export type ActivationLink = typeof ActivationLink.Type

// NOTE: One shape for a new account and for an email that already has one
// (D13). `account` is the ID and the name the caller typed, never what is
// stored for an existing account: no name, phone or email of an account the
// caller did not create is ever returned. A new account comes with the
// activation `link` to hand over; an existing one only gets the role, grant or
// membership (logged) and never a link, so `link` is absent.
export const InviteResult = Schema.Struct({
  account: AccountRef,
  link: Schema.optionalKey(ActivationLink),
})
export type InviteResult = typeof InviteResult.Type

// NOTE: a co-author is an existing author of the unit, chosen by ID: there is
// never a link, and the name is one the caller can already see in the unit.
export const CoAuthorAdded = Schema.Struct({ account: AccountRef })
export type CoAuthorAdded = typeof CoAuthorAdded.Type

export const SignInRequest = Schema.Struct({
  email: Email,
  password: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
})

export const LinkInfo = Schema.Struct({
  purpose: LinkPurpose,
  name: DisplayName,
  email: Schema.String,
  expiresAt: EpochMs,
})

export const ConsumeLinkRequest = Schema.Struct({
  token: LinkToken,
  password: NewPassword,
})

// ---- Accounts (administrator) ----------------------------------------------------

export const AccountRow = Schema.Struct({
  id: ApiId,
  email: Schema.String,
  name: DisplayName,
  active: Schema.Boolean,
  // NOTE: When the password was last set, so an author cannot quietly act as
  // a reviewer (D13). Absent until activation.
  passwordSetAt: Schema.optionalKey(EpochMs),
  grants: Schema.Array(GrantView),
})
export type AccountRow = typeof AccountRow.Type

export const GrantResult = Schema.Struct({
  account: AccountRow,
  link: Schema.optionalKey(ActivationLink),
})

// ---- Units ----------------------------------------------------------------------

export const UnitCode = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,15}$/),
)

export const Unit = Schema.Struct({
  id: ApiId,
  name: DisplayName,
  code: UnitCode,
})
export type Unit = typeof Unit.Type

export const UnitMember = Schema.Struct({
  accountId: ApiId,
  name: DisplayName,
  email: Schema.String,
  isAuthor: Schema.Boolean,
  isReviewer: Schema.Boolean,
  active: Schema.Boolean,
})

// ---- Reviewer registry and committees ----------------------------------------------

// NOTE: An entry of a unit's reviewer registry: what the unit holds about a
// person (the name and number its authors typed, and whether they asked for
// WhatsApp consent). It is never the person's own account data: the account's
// name and number, whether and when the person consented, and whether the
// person has set a password are not part of it (D13). Only the person gives
// WhatsApp consent, on their own account (`SetNotificationPreferences`).
export const Reviewer = Schema.Struct({
  accountId: ApiId,
  unit: ApiId,
  name: DisplayName,
  email: Schema.String,
  phone: Schema.optionalKey(Phone),
  // NOTE: The unit asked for consent; it says nothing about the answer.
  consentRequested: Schema.Boolean,
  active: Schema.Boolean,
})
export type Reviewer = typeof Reviewer.Type

// NOTE: What was added: the ID, and what the caller supplied, echoed. It never
// carries what is stored for an account that already existed (name, phone,
// consent, whether it is active); the caller reads what is visible in their
// unit with `ListReviewers`. Same shape for a new and an existing account; the
// activation `link` only for a new one (D13).
export const ReviewerAdded = Schema.Struct({
  accountId: ApiId,
  unit: ApiId,
  name: DisplayName,
  email: Email,
  phone: Schema.optionalKey(Phone),
  whatsappConsent: Schema.Boolean,
  link: Schema.optionalKey(ActivationLink),
})
export type ReviewerAdded = typeof ReviewerAdded.Type

export const CommitteeRecord = Schema.Struct({
  id: ApiId,
  unit: ApiId,
  name: DisplayName,
  memberIds: Schema.Array(ApiId).check(Schema.isMaxLength(200)),
  retired: Schema.Boolean,
})
export type CommitteeRecord = typeof CommitteeRecord.Type
