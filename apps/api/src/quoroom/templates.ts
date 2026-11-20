import { Effect, Result, Schema } from 'effect'
import type { RpcGroup } from 'effect/rpc'

import {
  type Problem,
  type QuoroomRpcs,
  type StoreTemplateSummary,
  type StoreTemplateVersionRecord,
  type Template,
  Conflict,
  CurrentUser,
  DEFAULT_THEME,
  NotFound,
  NotPermitted,
  StorageUnavailable,
  Validation,
  Template as TemplateSchema,
  Theme as ThemeSchema,
  blankTemplate,
  diffTemplates,
  slug,
  templateProblems,
  themeProblems,
  validateTemplate,
} from '@quoroom/domain'

import {
  QuoroomClock,
  allowCapability,
  idOf,
  problem,
  store,
  validation,
} from './core'
import { member } from './support'

// NOTE: Templates and the theme. A template version is immutable
// once published: a draft is saved in place, publishing freezes it and logs
// what changed since the previous version, and nothing ever rewrites a
// published one. A draft only has to fit the schema; whether it can be
// published is what `validateTemplate` says.

type AllHandlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof QuoroomRpcs>>

const decodeTemplate = Schema.decodeUnknownSync(TemplateSchema)
const decodeTheme = Schema.decodeUnknownSync(ThemeSchema)

const MAX_TEMPLATES = 60
const DEFAULT_PAGE = 50

const readTemplate = (stored: StoreTemplateVersionRecord): Template => {
  try {
    return decodeTemplate(JSON.parse(stored.definition))
  } catch {
    throw new StorageUnavailable({ message: 'template invalid' })
  }
}

const recordOf = (stored: StoreTemplateVersionRecord) =>
  Effect.try({
    try: () => ({
      templateId: stored.templateId,
      version: stored.version,
      state: stored.state,
      template: readTemplate(stored),
      draftRevision: stored.draftRevision,
      createdBy: stored.createdBy ?? 'system',
      createdAt: stored.createdAt,
      ...(stored.publishedAt === null ? {} : { publishedAt: stored.publishedAt }),
    }),
    catch: () => new StorageUnavailable({ message: 'template invalid' }),
  })

const problemsOf = (
  list: ReadonlyArray<{
    code: string
    path: ReadonlyArray<string | number>
    message: string
  }>,
  source: Problem['source'],
): ReadonlyArray<Problem> =>
  list
    .slice(0, 200)
    .map(entry => problem(source, entry.code.slice(0, 64), entry.path.slice(0, 32), entry.message.slice(0, 500)))

type Summary = {
  id: string
  name: string
  shortName: string
  builtIn: boolean
  latestVersion: number
  publishedVersion?: number
  hasDraft: boolean
  draftVersion?: number
  draftName?: string
  retired: boolean
}

// NOTE: `name` is the published version's (the newest retired one when the
// template is retired, the draft's only when nothing else exists); the draft
// is described apart.
const summariesOf = (
  versions: ReadonlyArray<StoreTemplateSummary>,
): ReadonlyArray<Summary> => {
  const byId = new Map<string, Array<StoreTemplateSummary>>()
  for (const version of versions) {
    byId.set(version.templateId, [...(byId.get(version.templateId) ?? []), version])
  }
  const newest = (list: ReadonlyArray<StoreTemplateSummary>) =>
    list.reduce<StoreTemplateSummary | undefined>(
      (a, b) => (a === undefined || b.version > a.version ? b : a),
      undefined,
    )
  return [...byId.entries()].map(([id, list]) => {
    const latest = newest(list) as StoreTemplateSummary
    const published = newest(list.filter(entry => entry.state === 'published'))
    const draft = newest(list.filter(entry => entry.state === 'draft'))
    const shown =
      published ?? newest(list.filter(entry => entry.state !== 'draft')) ?? latest
    return {
      id,
      name: shown.name,
      shortName: shown.shortName,
      builtIn: latest.builtin,
      latestVersion: latest.version,
      ...(published === undefined ? {} : { publishedVersion: published.version }),
      hasDraft: draft !== undefined,
      ...(draft === undefined ? {} : { draftVersion: draft.version, draftName: draft.name }),
      retired: published === undefined && list.some(entry => entry.state === 'retired'),
    }
  })
}

export const templateHandlers: Pick<
  AllHandlers,
  | 'ListTemplates'
  | 'ListPublishedTemplates'
  | 'GetTemplateVersion'
  | 'CreateTemplateDraft'
  | 'SaveTemplateDraft'
  | 'PublishTemplateVersion'
  | 'RetireTemplate'
  | 'RestoreTemplate'
  | 'DiscardTemplateDraft'
  | 'GetTheme'
  | 'UpdateTheme'
> = {
  ListTemplates: ({ offset, limit }) =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowCapability(db, { type: 'edit_template' })
      const all = [...summariesOf(yield* db.listTemplates())].sort(
        (a, b) =>
          a.name.localeCompare(b.name, 'en') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      const from = offset ?? 0
      const size = limit ?? DEFAULT_PAGE
      return {
        templates: all.slice(from, from + size),
        ...(from + size < all.length ? { next: from + size } : {}),
      }
    }),

  // NOTE: what an author chooses from when starting a report: the newest
  // published version of each template that is not retired.
  ListPublishedTemplates: () =>
    Effect.gen(function* () {
      const user = yield* CurrentUser
      const db = yield* store
      const grants = yield* db.listGrants(user.id)
      if (!grants.some(grant => grant.capability === 'author')) {
        return yield* Effect.fail(new NotPermitted({ reason: 'not_permitted' }))
      }
      const out = []
      const published = summariesOf(yield* db.listTemplates())
        .filter(summary => summary.publishedVersion !== undefined)
        .slice(0, MAX_TEMPLATES)
      // NOTE: all the published versions in one read.
      const stored = new Map(
        (yield* db.getTemplateVersions(
          published.map(summary => ({
            templateId: summary.id,
            version: summary.publishedVersion as number,
          })),
        )).map(record => [`${record.templateId}@${record.version}`, record]),
      )
      for (const summary of published) {
        if (summary.publishedVersion === undefined) continue
        const stored_ = stored.get(`${summary.id}@${summary.publishedVersion}`)
        if (stored_ === undefined) continue
        const template = yield* Effect.try({
          try: () => readTemplate(stored_),
          catch: () => new StorageUnavailable({ message: 'template invalid' }),
        })
        out.push({
          id: summary.id,
          version: summary.publishedVersion,
          name: template.name,
          shortName: template.shortName,
          caseReferenceLabel: template.caseReferenceLabel,
          ...(template.description === undefined
            ? {}
            : { description: template.description }),
        })
      }
      return out
    }),

  // NOTE: a template editor reads any version. Anyone else must name a report
  // that uses this version (and, for a reviewer, the revision sent to them);
  // `authorize` decides, and anything else is `NotFound`.
  GetTemplateVersion: ({ templateId, version, reportId, revision }) =>
    Effect.gen(function* () {
      const db = yield* store
      if (reportId === undefined) {
        yield* allowCapability(db, { type: 'preview_template' })
      } else {
        const { loaded } = yield* member(reportId, {
          type: 'read_template_version',
          ...(revision === undefined ? {} : { revision }),
        })
        if (
          loaded.record.templateId !== templateId ||
          loaded.record.templateVersion !== version
        ) {
          return yield* Effect.fail(new NotFound())
        }
      }
      const stored = yield* db.getTemplateVersion(templateId, version)
      if (stored === null) return yield* Effect.fail(new NotFound())
      return yield* recordOf(stored)
    }),

  // NOTE: blank, a copy under a new name, or (a copy with no name) the next
  // draft of the same template. A template has at most one draft.
  CreateTemplateDraft: ({ copyOf, name }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, {
        type: copyOf === undefined ? 'create_template' : 'copy_template',
      })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      let templateId: string
      let version = 1
      let template: Template
      if (copyOf === undefined) {
        templateId = yield* idOf('tpl')
        template = blankTemplate(templateId, name ?? 'New template')
      } else {
        const source = yield* db.getTemplateVersion(copyOf.templateId, copyOf.version)
        if (source === null) return yield* Effect.fail(new NotFound())
        const original = yield* Effect.try({
          try: () => readTemplate(source),
          catch: () => new StorageUnavailable({ message: 'template invalid' }),
        })
        if (name === undefined) {
          if (source.builtin) {
            return yield* Effect.fail(
              validation('input', 'builtin_copy_only', ['copyOf']),
            )
          }
          templateId = copyOf.templateId
          version =
            Math.max(
              ...(yield* db.listTemplates())
                .filter(entry => entry.templateId === templateId)
                .map(entry => entry.version),
            ) + 1
          template = { ...original, version }
        } else {
          templateId = yield* idOf('tpl')
          template = { ...original, id: templateId, version, name, shortName: slug(name) }
        }
      }
      const checked = validateTemplate(JSON.parse(JSON.stringify(template)))
      if (Result.isFailure(checked)) {
        return yield* Effect.fail(validationOf(problemsOf(checked.failure, 'template')))
      }
      const created = yield* db.createTemplateDraft({
        templateId,
        version,
        name: template.name,
        shortName: template.shortName,
        definition: JSON.stringify(template),
        createdBy: user.id,
        now,
        audit: {
          at: now,
          actorId: user.id,
          action: 'template.draft_created',
          templateId,
          meta: JSON.stringify({ version }),
        },
      })
      if (created._tag === 'Refused') {
        return yield* Effect.fail(
          new Conflict({
            reason: created.reason === 'draft_exists' ? 'already_exists' : 'changed_meanwhile',
          }),
        )
      }
      const stored = yield* db.getTemplateVersion(templateId, version)
      if (stored === null) return yield* Effect.fail(new NotFound())
      return yield* recordOf(stored)
    }),

  SaveTemplateDraft: ({ templateId, version, draftRevision, template }) =>
    Effect.gen(function* () {
      const db = yield* store
      yield* allowCapability(db, { type: 'edit_template' })
      if (template.id !== templateId || template.version !== version) {
        return yield* Effect.fail(validation('input', 'template_mismatch'))
      }
      const saved = yield* db.saveTemplateDraft({
        templateId,
        version,
        name: template.name,
        shortName: template.shortName,
        definition: JSON.stringify(template),
        expectedRevision: draftRevision,
      })
      if (saved._tag === 'Refused') {
        const exists = yield* db.getTemplateVersion(templateId, version)
        return yield* Effect.fail(
          exists === null
            ? new NotFound()
            : new Conflict({
                reason: saved.reason === 'stale' ? 'stale_save' : 'changed_meanwhile',
              }),
        )
      }
      const stored = yield* db.getTemplateVersion(templateId, version)
      if (stored === null) return yield* Effect.fail(new NotFound())
      return {
        record: yield* recordOf(stored),
        problems: problemsOf(templateProblems(template), 'template'),
      }
    }),

  // NOTE: refused while the draft has problems. The version becomes immutable
  // and the audit event holds the difference from the previous version.
  PublishTemplateVersion: ({ templateId, version, draftRevision }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'publish_template' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const stored = yield* db.getTemplateVersion(templateId, version)
      if (stored === null) return yield* Effect.fail(new NotFound())
      if (stored.state !== 'draft') {
        return yield* Effect.fail(new Conflict({ reason: 'changed_meanwhile' }))
      }
      if (stored.draftRevision !== draftRevision) {
        return yield* Effect.fail(new Conflict({ reason: 'stale_save' }))
      }
      const checked = validateTemplate(JSON.parse(stored.definition))
      if (Result.isFailure(checked)) {
        return yield* Effect.fail(
          validationOf(problemsOf(checked.failure, 'template')),
        )
      }
      const previousVersion = (yield* db.listTemplates())
        .filter(
          entry =>
            entry.templateId === templateId &&
            entry.version < version &&
            entry.state !== 'draft',
        )
        .reduce<number | undefined>(
          (best, entry) => (best === undefined || entry.version > best ? entry.version : best),
          undefined,
        )
      const previous =
        previousVersion === undefined
          ? undefined
          : yield* db.getTemplateVersion(templateId, previousVersion)
      const changes = diffTemplates(
        previous === null || previous === undefined ? undefined : readTemplate(previous),
        checked.success,
      )
      const count = (kind: string): number =>
        changes.filter(change => change.change === kind).length
      const published = yield* db.publishTemplateVersion({
        templateId,
        version,
        changes: JSON.stringify(changes),
        publishedBy: user.id,
        now,
        expectedRevision: draftRevision,
        audit: {
          at: now,
          actorId: user.id,
          action: 'template.published',
          templateId,
          meta: JSON.stringify({
            version,
            added: count('added'),
            removed: count('removed'),
            changed: count('changed'),
            summary: changes
              .slice(0, 8)
              .map(change => `${change.change} ${change.target} ${change.id ?? change.label}`)
              .join('; ')
              .slice(0, 200),
          }),
        },
      })
      if (published._tag === 'Refused') {
        return yield* Effect.fail(
          published.reason === 'retired'
            ? validation('input', 'template_retired')
            : new Conflict({
                reason: published.reason === 'stale' ? 'stale_save' : 'changed_meanwhile',
              }),
        )
      }
      const after = yield* db.getTemplateVersion(templateId, version)
      if (after === null) return yield* Effect.fail(new NotFound())
      return { record: yield* recordOf(after), changes }
    }),

  RetireTemplate: ({ templateId }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'retire_template' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const retired = yield* db.retireTemplate(templateId, now, {
        at: now,
        actorId: user.id,
        action: 'template.retired',
        templateId,
      })
      if (retired._tag === 'Refused') {
        return yield* Effect.fail(validation('input', 'not_published'))
      }
      const summary = summariesOf(yield* db.listTemplates()).find(
        entry => entry.id === templateId,
      )
      if (summary === undefined) return yield* Effect.fail(new NotFound())
      return summary
    }),

  RestoreTemplate: ({ templateId }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'retire_template' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const restored = yield* db.restoreTemplate(templateId, {
        at: now,
        actorId: user.id,
        action: 'template.restored',
        templateId,
      })
      if (restored._tag === 'Refused') {
        return yield* Effect.fail(validation('input', 'not_retired'))
      }
      const summary = summariesOf(yield* db.listTemplates()).find(
        entry => entry.id === templateId,
      )
      if (summary === undefined) return yield* Effect.fail(new NotFound())
      return summary
    }),

  // NOTE: works on a draft that cannot be read too: that is how a broken
  // draft is recovered.
  DiscardTemplateDraft: ({ templateId, version }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'edit_template' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const discarded = yield* db.discardTemplateDraft(templateId, version, {
        at: now,
        actorId: user.id,
        action: 'template.draft_discarded',
        templateId,
        meta: JSON.stringify({ version }),
      })
      if (discarded._tag === 'Refused') return yield* Effect.fail(new NotFound())
    }),

  GetTheme: () =>
    Effect.gen(function* () {
      const db = yield* store
      const stored = yield* db.getTheme()
      if (stored === null) return { theme: DEFAULT_THEME }
      const theme = (() => {
        try {
          return decodeTheme(JSON.parse(stored.settings))
        } catch {
          return DEFAULT_THEME
        }
      })()
      return {
        theme,
        updatedAt: stored.updatedAt,
        ...(stored.updatedBy === null ? {} : { updatedBy: stored.updatedBy }),
      }
    }),

  // NOTE: refused with the problems found when the colours would be
  // unreadable (contrast) or a token is unknown; the logo must be a complete
  // image uploaded for the theme.
  UpdateTheme: ({ theme }) =>
    Effect.gen(function* () {
      const db = yield* store
      const { user } = yield* allowCapability(db, { type: 'set_theme' })
      const clock = yield* QuoroomClock
      const now = yield* clock.now
      const found = problemsOf(themeProblems(theme), 'theme')
      if (found.length > 0) return yield* Effect.fail(validationOf(found))
      if (theme.logo !== undefined) {
        const image = yield* db.getImage(theme.logo)
        if (image === null || image.owner.kind !== 'theme' || !image.complete) {
          return yield* Effect.fail(validation('theme', 'unknown_logo', ['logo']))
        }
      }
      yield* db.putTheme(
        {
          settings: JSON.stringify(theme),
          logoImageId: theme.logo ?? null,
          updatedAt: now,
          updatedBy: user.id,
        },
        {
          at: now,
          actorId: user.id,
          action: 'theme.updated',
          meta: JSON.stringify({ organisationName: theme.organisationName.slice(0, 100) }),
        },
      )
      return { theme, updatedAt: now, updatedBy: user.id }
    }),
}

const validationOf = (problems: ReadonlyArray<Problem>): Validation =>
  new Validation({ problems })
