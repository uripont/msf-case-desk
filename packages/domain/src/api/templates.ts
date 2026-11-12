import { Schema } from 'effect'

import { Template, TemplateId } from '../template'
import { Theme } from '../theme'
import { ApiId, DisplayName, EpochMs, Problem } from './common'

// NOTE: Templates and the theme (stage 9). Template procedures need the
// template editor capability; they give no access to any report. A template
// version is immutable once published, so a client may cache one by
// `(templateId, version)`.

export const TemplateVersionState = Schema.Literals([
  'draft',
  'published',
  'retired',
])

export const TemplateSummary = Schema.Struct({
  id: TemplateId,
  name: DisplayName,
  shortName: Schema.String,
  builtIn: Schema.Boolean,
  latestVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  publishedVersion: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  ),
  hasDraft: Schema.Boolean,
  retired: Schema.Boolean,
})
export type TemplateSummary = typeof TemplateSummary.Type

// NOTE: What an author sees when choosing a template for a new report: only
// published, not retired templates, and no definition.
export const PublishedTemplate = Schema.Struct({
  id: TemplateId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  name: DisplayName,
  shortName: Schema.String,
  caseReferenceLabel: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

export const TemplateVersionRecord = Schema.Struct({
  templateId: TemplateId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: TemplateVersionState,
  // NOTE: A draft only has to fit the schema. Whether it is publishable is
  // what `validateTemplate` says, returned as problems.
  template: Template,
  createdBy: ApiId,
  createdAt: EpochMs,
  publishedAt: Schema.optionalKey(EpochMs),
})
export type TemplateVersionRecord = typeof TemplateVersionRecord.Type

export const TemplateChange = Schema.Struct({
  change: Schema.Literals(['added', 'removed', 'changed']),
  target: Schema.Literals([
    'section',
    'item',
    'role',
    'numbering',
    'cover',
    'furniture',
    'setting',
  ]),
  id: Schema.optionalKey(Schema.String),
  label: Schema.String.check(Schema.isMaxLength(200)),
})
export type TemplateChange = typeof TemplateChange.Type

export const TemplateRef = Schema.Struct({
  templateId: TemplateId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})

export const SavedTemplateDraft = Schema.Struct({
  record: TemplateVersionRecord,
  problems: Schema.Array(Problem).check(Schema.isMaxLength(200)),
})

export const PublishedTemplateVersion = Schema.Struct({
  record: TemplateVersionRecord,
  // NOTE: Differences from the previous published version (D23), also kept in
  // the audit event.
  changes: Schema.Array(TemplateChange).check(Schema.isMaxLength(500)),
})

// ---- Theme ------------------------------------------------------------------------

export const ThemeRecord = Schema.Struct({
  theme: Theme,
  updatedAt: Schema.optionalKey(EpochMs),
  updatedBy: Schema.optionalKey(ApiId),
})
export type ThemeRecord = typeof ThemeRecord.Type
