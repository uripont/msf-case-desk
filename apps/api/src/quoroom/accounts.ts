import { Effect, Option } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type AccountRecord,
  type ActivationLink,
  type GrantRecord,
  type ProfileInput,
  type ReviewerEntryInput,
  type QuoroomRpcs,
  type UnitReviewerRecord,
  type StoreCapabilityName,
  Conflict,
  CurrentUser,
  NotFound,
  NotPermitted,
  Repository,
  StorageUnavailable,
  normaliseEmail,
} from '@case-desk/domain'

import { LINK_TTL_MS, UNUSABLE_PASSWORD_HASH } from '../links'
import { clearedSessionCookie, hashToken, tokenFromCookies } from '../session'
import { setCookie } from './cookies'
import {
  type Store,
  QuoroomClock,
  allowCapability,
  idOf,
  randomToken,
  store,
  validation,
} from './core'

// NOTE: Session, accounts, capabilities, units, unit membership, the reviewer
// registry and committees (stage 3a and 3b of the contract).
//
// D13. A person invited with an email that already has an account is never
// told so: the response has the same shape as for a new one, built from what
// the caller typed, and carries no link. The grant, link or membership is
// still made, and logged.

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

export { LINK_TTL_MS, UNUSABLE_PASSWORD_HASH }

const MAX_ACCOUNTS_LISTED = 2000

const grantView = (grant: GrantRecord) => ({
  capability: grant.capability,
  ...(grant.unitId === null ? {} : { unit: grant.unitId }),
})

const profileView = (account: AccountRecord) => ({
  ...(account.profile?.phone == null ? {} : { phone: account.profile.phone }),
  whatsappConsent: account.profile?.whatsappConsent ?? false,
  notifyOnApproval: account.profile?.notifyOnApproval ?? false,
})

export const meOf = (
  account: AccountRecord,
  grants: ReadonlyArray<GrantRecord>,
) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  grants: grants.filter(grant => grant.userId === account.id).map(grantView),
  profile: profileView(account),
})

// NOTE: the person behind a session, for `GetMe`, sign-in and links.
export const meFor = (db: Store, userId: string) =>
  Effect.gen(function* () {
    const account = yield* db.getAccount(userId)
    if (account === null) {
      return yield* Effect.fail(new StorageUnavailable({ message: 'account missing' }))
    }
    const grants = yield* db.listGrants(userId)
    return meOf(account, grants)
  })

const rowOf = (account: AccountRecord, grants: ReadonlyArray<GrantRecord>) => ({
  id: account.id,
  email: account.email,
  name: account.name,
  active: account.profile?.active ?? true,
  ...(account.profile?.passwordSetAt == null
    ? {}
    : { passwordSetAt: account.profile.passwordSetAt }),
  grants: grants.filter(grant => grant.userId === account.id).map(grantView),
})

// NOTE: an entry of the unit's registry: the unit's own name and number, and
// whether it asked for consent. Nothing of the account behind it (D13).
const reviewerOf = (entry: UnitReviewerRecord) => ({
  accountId: entry.userId,
  unit: entry.unitId,
  name: entry.name,
  email: entry.email,
  ...(entry.phone === null ? {} : { phone: entry.phone }),
  consentRequested: entry.consentRequested,
  active: entry.active,
})

const committeeOf = (committee: {
  id: string
  unitId: string
  name: string
  memberIds: ReadonlyArray<string>
  archivedAt: number | null
}) => ({
  id: committee.id,
  unit: committee.unitId,
  name: committee.name,
  memberIds: committee.memberIds,
  retired: committee.archivedAt !== null,
})

// NOTE: a link for an account: the token is returned once to the caller and
// only its hash is stored.
export const makeInvitation = (
  userId: string,
  purpose: 'activate' | 'reset',
  issuedBy: string | null,
  now: number,
) =>
  Effect.gen(function* () {
    const token = randomToken()
    const invitation = {
      id: yield* idOf('inv'),
      tokenHash: yield* Effect.promise(() => hashToken(token)),
      userId,
      purpose,
      expiresAt: now + LINK_TTL_MS,
      issuedBy,
      createdAt: now,
    }
    return {
      invitation,
      link: { purpose, token, expiresAt: invitation.expiresAt },
    }
  })

type NewAccountInput = Readonly<{
  email: string
  name: string
  createdBy: string
  now: number
  action: string
  grant?: Readonly<{ capability: StoreCapabilityName; unitId?: string }>
  reviewerOfUnit?: string
  // NOTE: what the unit holds for the person (the registry entry).
  reviewerEntry?: ReviewerEntryInput
  phone?: string | null
}>

// NOTE: a new account: no password (an unusable hash), its profile, the grant
// or the unit link, an activation link and the audit event, in one batch.
export const createInvited = (db: Store, input: NewAccountInput) =>
  Effect.gen(function* () {
    const id = yield* idOf('acc')
    const { invitation, link } = yield* makeInvitation(
      id,
      'activate',
      input.createdBy,
      input.now,
    )
    // NOTE: a brand new account gets the number the author typed, but never
    // consent: only the person gives that, on their own account.
    const profile: ProfileInput = {
      phone: input.phone ?? null,
      whatsappConsent: false,
      whatsappConsentAt: null,
      notifyOnApproval: false,
      active: true,
    }
    const created = yield* db.createAccount({
      id,
      email: input.email,
      name: input.name,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      profile,
      ...(input.grant === undefined ? {} : { grant: input.grant }),
      ...(input.reviewerOfUnit === undefined
        ? {}
        : { reviewerOfUnit: input.reviewerOfUnit }),
      ...(input.reviewerEntry === undefined
        ? {}
        : { reviewerEntry: input.reviewerEntry }),
      invitation,
      createdBy: input.createdBy,
      now: input.now,
      audit: {
        at: input.now,
        actorId: input.createdBy,
        action: input.action,
        meta: JSON.stringify({ accountId: id }),
      },
    })
    if (created._tag === 'Refused') {
      return yield* Effect.fail(
        created.reason === 'no_unit'
          ? validation('input', 'unknown_unit')
          : new Conflict({ reason: 'changed_meanwhile' }),
      )
    }
    return { id, link }
  })

// NOTE: the units a caller holds an author grant in.
const authorUnits = (grants: ReadonlyArray<GrantRecord>): ReadonlyArray<string> =>
  grants
    .filter(grant => grant.capability === 'author' && grant.unitId !== null)
    .map(grant => grant.unitId as string)

const toNowAndActor = Effect.gen(function* () {
  const user = yield* CurrentUser
  const clock = yield* QuoroomClock
  return { user, now: yield* clock.now }
})

const reviewersOf = (db: Store, unit: string) => db.listUnitReviewers(unit)

export const accountHandlers: Pick<
  AllHandlers,
  | 'GetMe'
  | 'SignOut'
  | 'SetNotificationPreferences'
  | 'ListAccounts'
  | 'IssueReset'
  | 'GrantCapability'
  | 'RevokeCapability'
  | 'ListUnits'
  | 'CreateUnit'
  | 'UpdateUnit'
  | 'ListUnitMembers'
  | 'InviteToUnit'
  | 'ListReviewers'
  | 'AddReviewer'
  | 'UpdateReviewer'
  | 'ListCommittees'
  | 'CreateCommittee'
  | 'UpdateCommittee'
> = {
  GetMe: () =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      return yield* meFor(db, user.id)
    }),

  // NOTE: ends this session only, and clears the cookie. A password reset
  // ends every session (`consumeInvitation`).
  SignOut: (_payload, { headers }) =>
    Effect.gen(function* () {
      const repository = yield* Repository
      const token = tokenFromCookies(headers['cookie'] ?? null)
      if (Option.isSome(token)) {
        const hash = yield* Effect.promise(() => hashToken(token.value))
        yield* repository
          .deleteSession(hash)
          .pipe(
            Effect.mapError(
              error => new StorageUnavailable({ message: error.message }),
            ),
          )
      }
      setCookie(headers, clearedSessionCookie())
    }),

  SetNotificationPreferences: ({ notifyOnApproval, phone, whatsappConsent }) =>
    Effect.gen(function* () {
      const { user, now } = yield* toNowAndActor
      const db = yield* store
      const account = yield* db.getAccount(user.id)
      const current = account?.profile ?? null
      // NOTE: the person's own number and consent, on their own account.
      const nextPhone = phone === undefined ? (current?.phone ?? null) : phone
      const consent =
        nextPhone === null
          ? false
          : (whatsappConsent ?? current?.whatsappConsent ?? false)
      yield* db.putProfile(
        user.id,
        {
          phone: nextPhone,
          whatsappConsent: consent,
          whatsappConsentAt: !consent
            ? null
            : current?.whatsappConsent === true && current.whatsappConsentAt !== null
              ? current.whatsappConsentAt
              : now,
          notifyOnApproval,
          active: current?.active ?? true,
        },
        now,
      )
      const after = yield* db.getAccount(user.id)
      if (after === null) {
        return yield* Effect.fail(new StorageUnavailable({ message: 'account missing' }))
      }
      return profileView(after)
    }),

  ListAccounts: () =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowCapability(db, { type: 'manage_grants' })
      const accounts = yield* db.listAccounts()
      const grants = yield* db.listGrants()
      return accounts
        .slice(0, MAX_ACCOUNTS_LISTED)
        .map(account => rowOf(account, grants))
    }),

  IssueReset: ({ accountId }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'issue_reset' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const account = yield* db.getAccount(accountId)
      if (account === null) return yield* Effect.fail(new NotFound())
      const { invitation, link } = yield* makeInvitation(
        accountId,
        'reset',
        user.id,
        now,
      )
      yield* db.createInvitation(
        invitation,
        {
          at: now,
          actorId: user.id,
          action: 'account.reset_issued',
          meta: JSON.stringify({ accountId }),
        },
      )
      return link
    }),

  // NOTE: by email. A new email makes the account, with its activation link;
  // an existing one only gets the grant, and no link.
  GrantCapability: ({ email, name, capability, unit }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_grants' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      if ((capability === 'author') !== (unit !== undefined)) {
        return yield* Effect.fail(
          validation('input', capability === 'author' ? 'unit_required' : 'unit_not_allowed'),
        )
      }
      const address = normaliseEmail(email)
      const existing = yield* db.findAccountByEmail(address)
      let accountId: string
      let link: ActivationLink | undefined
      if (existing === null) {
        if (name === undefined) {
          return yield* Effect.fail(validation('input', 'name_required'))
        }
        const created = yield* createInvited(db, {
          email: address,
          name,
          createdBy: user.id,
          now,
          action: 'account.created',
          grant: {
            capability,
            ...(unit === undefined ? {} : { unitId: unit }),
          },
        })
        accountId = created.id
        link = created.link
      } else {
        accountId = existing.id
        const granted = yield* db.grantCapability({
          userId: accountId,
          capability,
          unitId: unit ?? null,
          grantedBy: user.id,
          grantedAt: now,
        })
        if (granted === 'no_unit') {
          return yield* Effect.fail(validation('input', 'unknown_unit'))
        }
        if (granted === 'granted') {
          yield* db.appendAudit({
            at: now,
            actorId: user.id,
            action: 'capability.granted',
            meta: JSON.stringify({
              accountId,
              capability,
              ...(unit === undefined ? {} : { unit }),
            }),
          })
        }
      }
      const account = yield* db.getAccount(accountId)
      if (account === null) {
        return yield* Effect.fail(new StorageUnavailable({ message: 'account missing' }))
      }
      const grants = yield* db.listGrants(accountId)
      return {
        account: rowOf(account, grants),
        ...(link === undefined ? {} : { link }),
      }
    }),

  RevokeCapability: ({ accountId, capability, unit }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_grants' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const all = yield* db.listGrants()
      // NOTE: the last administrator cannot be removed: nobody could grant
      // anything again.
      if (
        capability === 'admin' &&
        all.filter(grant => grant.capability === 'admin').length <= 1
      ) {
        return yield* Effect.fail(validation('input', 'last_admin'))
      }
      const removed = yield* db.revokeCapability(accountId, capability, unit ?? null)
      if (!removed) return yield* Effect.fail(new NotFound())
      yield* db.appendAudit({
        at: now,
        actorId: user.id,
        action: 'capability.revoked',
        meta: JSON.stringify({
          accountId,
          capability,
          ...(unit === undefined ? {} : { unit }),
        }),
      })
      const account = yield* db.getAccount(accountId)
      if (account === null) return yield* Effect.fail(new NotFound())
      return rowOf(account, yield* db.listGrants(accountId))
    }),

  // NOTE: administrators see every unit; anyone else the units they hold a
  // grant in.
  ListUnits: () =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const grants = yield* db.listGrants(user.id)
      const units = yield* db.listUnits()
      const isAdmin = grants.some(grant => grant.capability === 'admin')
      const mine = new Set(authorUnits(grants))
      return units
        .filter(unit => isAdmin || mine.has(unit.id))
        .map(unit => ({ id: unit.id, name: unit.name, code: unit.code }))
    }),

  CreateUnit: ({ name, code }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_units' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const id = yield* idOf('unit')
      const created = yield* db.createUnit({ id, name, code, createdAt: now })
      if (created._tag === 'Refused') {
        return yield* Effect.fail(new Conflict({ reason: 'duplicate' }))
      }
      yield* db.appendAudit({
        at: now,
        actorId: user.id,
        action: 'unit.created',
        meta: JSON.stringify({ unit: id }),
      })
      return { id, name, code }
    }),

  UpdateUnit: ({ unit, name }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_units' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const updated = yield* db.updateUnit(unit, name, now)
      if (updated === null) return yield* Effect.fail(new NotFound())
      yield* db.appendAudit({
        at: now,
        actorId: user.id,
        action: 'unit.updated',
        meta: JSON.stringify({ unit }),
      })
      return { id: updated.id, name: updated.name, code: updated.code }
    }),

  // NOTE: two reads, whatever the size of the unit: the registry and the
  // accounts holding the author capability in it. A registry person shows the
  // unit's own name; an author shows the account's.
  ListUnitMembers: ({ unit }) =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowCapability(db, { type: 'invite_to_unit', unit })
      const reviewers = yield* reviewersOf(db, unit)
      const authorAccounts = yield* db.listUnitAuthors(unit)
      const everyone = new Map<
        string,
        { name: string; email: string; active: boolean }
      >(
        reviewers.map(entry => [
          entry.userId,
          { name: entry.name, email: entry.email, active: entry.active },
        ]),
      )
      for (const account of authorAccounts) {
        everyone.set(account.id, {
          name: account.name,
          email: account.email,
          active: account.profile?.active ?? true,
        })
      }
      const authors = new Set(authorAccounts.map(account => account.id))
      const reviewerIds = new Set(reviewers.map(entry => entry.userId))
      return [...everyone.entries()]
        .sort((a, b) => a[1].name.localeCompare(b[1].name))
        .map(([accountId, person]) => ({
          accountId,
          name: person.name,
          email: person.email,
          isAuthor: authors.has(accountId),
          isReviewer: reviewerIds.has(accountId),
          active: person.active,
        }))
    }),

  // NOTE: a person to take part in this unit's reviews: an entry of the
  // reviewer registry, with no phone and no grant.
  InviteToUnit: ({ unit, email, name }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'invite_to_unit', unit })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const address = normaliseEmail(email)
      const existing = yield* db.findAccountByEmail(address)
      if (existing === null) {
        const created = yield* createInvited(db, {
          email: address,
          name,
          createdBy: user.id,
          now,
          action: 'account.invited',
          reviewerOfUnit: unit,
          reviewerEntry: { displayName: name, phone: null, consentRequested: false },
        })
        return { account: { id: created.id, name }, link: created.link }
      }
      const linked = yield* db.linkReviewer(
        unit,
        existing.id,
        user.id,
        now,
        {
          at: now,
          actorId: user.id,
          action: 'unit.reviewer_linked',
          meta: JSON.stringify({ accountId: existing.id, unit }),
        },
        { displayName: name, phone: null, consentRequested: false },
      )
      if (linked === 'no_unit') {
        return yield* Effect.fail(validation('input', 'unknown_unit'))
      }
      return { account: { id: existing.id, name } }
    }),

  ListReviewers: ({ unit }) =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowCapability(db, { type: 'manage_committees', unit })
      return (yield* reviewersOf(db, unit)).map(reviewerOf)
    }),

  // NOTE: D13. The answer is built from what the caller typed. A new email
  // makes an account; an existing one is only linked into this unit's
  // registry, with the unit's own entry (the typed name and number), and
  // nothing of the account is read, changed or revealed. Consent is only
  // requested.
  AddReviewer: ({ unit, name, email, phone, whatsappConsent }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_committees', unit })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      if (whatsappConsent && phone === undefined) {
        return yield* Effect.fail(validation('input', 'phone_required_for_consent'))
      }
      const address = normaliseEmail(email)
      const existing = yield* db.findAccountByEmail(address)
      const echoed = {
        unit,
        name,
        email,
        ...(phone === undefined ? {} : { phone }),
        whatsappConsent,
      }
      const entry = {
        displayName: name,
        phone: phone ?? null,
        consentRequested: whatsappConsent,
      }
      if (existing === null) {
        const created = yield* createInvited(db, {
          email: address,
          name,
          createdBy: user.id,
          now,
          action: 'reviewer.added',
          reviewerOfUnit: unit,
          reviewerEntry: entry,
          phone: phone ?? null,
        })
        return { accountId: created.id, ...echoed, link: created.link }
      }
      const linked = yield* db.linkReviewer(
        unit,
        existing.id,
        user.id,
        now,
        {
          at: now,
          actorId: user.id,
          action: 'reviewer.linked',
          meta: JSON.stringify({ accountId: existing.id, unit }),
        },
        entry,
      )
      if (linked === 'no_unit') {
        return yield* Effect.fail(validation('input', 'unknown_unit'))
      }
      return { accountId: existing.id, ...echoed }
    }),

  // NOTE: only the unit's own entry changes: the account's name and number
  // are the person's, and WhatsApp consent is theirs to give.
  UpdateReviewer: ({ unit, accountId, name, phone, whatsappConsent }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_committees', unit })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const target = (yield* reviewersOf(db, unit)).find(
        entry => entry.userId === accountId,
      )
      if (target === undefined) return yield* Effect.fail(new NotFound())
      const nextPhone = phone === undefined ? target.phone : phone
      if (whatsappConsent === true && nextPhone === null) {
        return yield* Effect.fail(validation('input', 'phone_required_for_consent'))
      }
      // NOTE: no number, no request for consent.
      const consentRequested =
        nextPhone === null ? false : whatsappConsent
      const updated = yield* db.updateUnitReviewer({
        unitId: unit,
        userId: accountId,
        ...(name === undefined ? {} : { displayName: name }),
        ...(phone === undefined ? {} : { phone }),
        ...(consentRequested === undefined ? {} : { consentRequested }),
        audit: {
          at: now,
          actorId: user.id,
          action: 'reviewer.updated',
          meta: JSON.stringify({ accountId, unit }),
        },
      })
      if (updated === 'not_found') return yield* Effect.fail(new NotFound())
      const after = (yield* reviewersOf(db, unit)).find(
        entry => entry.userId === accountId,
      )
      if (after === undefined) return yield* Effect.fail(new NotFound())
      return reviewerOf(after)
    }),

  ListCommittees: ({ unit }) =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowCapability(db, { type: 'manage_committees', unit })
      return (yield* db.listCommittees(unit)).map(committeeOf)
    }),

  CreateCommittee: ({ unit, name, memberIds }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'manage_committees', unit })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const reviewers = new Set((yield* reviewersOf(db, unit)).map(a => a.userId))
      if (memberIds.some(id => !reviewers.has(id))) {
        return yield* Effect.fail(validation('input', 'member_not_in_unit'))
      }
      const id = yield* idOf('committee')
      const created = yield* db.createCommittee({
        id,
        unitId: unit,
        name,
        memberIds: [...new Set(memberIds)],
        createdBy: user.id,
        now,
        audit: {
          at: now,
          actorId: user.id,
          action: 'committee.created',
          meta: JSON.stringify({ committee: id, unit }),
        },
      })
      if (created._tag === 'Refused') {
        return yield* Effect.fail(
          created.reason === 'duplicate'
            ? new Conflict({ reason: 'duplicate' })
            : new NotPermitted({ reason: 'not_permitted' }),
        )
      }
      const made = (yield* db.listCommittees(unit)).find(c => c.id === id)
      if (made === undefined) return yield* Effect.fail(new NotFound())
      return committeeOf(made)
    }),

  // NOTE: the committee is looked up among the units the caller is an author
  // in; one anywhere else answers as if it did not exist.
  UpdateCommittee: ({ committeeId, name, memberIds, retired }) =>
    Effect.gen(function* () {
      const db = yield* store
      const user = yield* CurrentUser
      const grants = yield* db.listGrants(user.id)
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      // NOTE: one read of the committee, and a committee of a unit the caller
      // is no author in answers as if it did not exist.
      const found = yield* db.getCommittee(committeeId)
      if (found === null || !authorUnits(grants).includes(found.unitId)) {
        return yield* Effect.fail(new NotFound())
      }
      const unit = found.unitId
      yield* allowCapability(db, { type: 'manage_committees', unit })
      if (memberIds !== undefined) {
        const reviewers = new Set((yield* reviewersOf(db, unit)).map(a => a.userId))
        if (memberIds.some(id => !reviewers.has(id))) {
          return yield* Effect.fail(validation('input', 'member_not_in_unit'))
        }
      }
      const updated = yield* db.updateCommittee({
        id: committeeId,
        ...(name === undefined ? {} : { name }),
        ...(retired === undefined ? {} : { archived: retired }),
        ...(memberIds === undefined ? {} : { memberIds: [...new Set(memberIds)] }),
        now,
        audit: {
          at: now,
          actorId: user.id,
          action: 'committee.updated',
          meta: JSON.stringify({ committee: committeeId, unit }),
        },
      })
      if (!updated) return yield* Effect.fail(new NotFound())
      const after = (yield* db.listCommittees(unit)).find(c => c.id === committeeId)
      if (after === undefined) return yield* Effect.fail(new NotFound())
      return committeeOf(after)
    }),
}
