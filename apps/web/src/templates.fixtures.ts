import { Result } from 'effect'

import {
  INTAKE_TEMPLATE,
  type Template,
  type TemplateSummary,
  type TemplateVersionRecord,
  templateOfForm,
} from '@quoroom/domain'
import { PANEL_START } from '@quoroom/domain/testing/template-edits'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { NOW } from './publish.fixtures'
import { signedInAs, withGrants } from './quoroom.fixtures'
import * as TemplateEditor from './quoroom/templateEditor'
import * as Templates from './quoroom/templates'

// NOTE: With invented data: a template editor, the template list,
// and the editor opened on a draft of the blank template.

export const EDITOR_ME = withGrants([{ capability: 'template_editor' }])
export const editorModel = signedInAs(EDITOR_ME)

const blank = (() => {
  const built = templateOfForm(PANEL_START)
  if (Result.isFailure(built)) throw new Error('the blank template is invalid')
  return built.success
})()

export const recordOf = (
  template: Template,
  state: 'draft' | 'published' | 'retired' = 'draft',
): TemplateVersionRecord => ({
  templateId: template.id,
  version: template.version,
  state,
  template,
  draftRevision: 0,
  createdBy: 'tess',
  createdAt: NOW,
  ...(state === 'draft' ? {} : { publishedAt: NOW }),
})

export const BLANK_RECORD = recordOf(blank)

export const scopeOf = (record: TemplateVersionRecord) => ({
  templateId: record.templateId,
  version: record.version,
  generation: 1,
})

export const editorMessage = (message: TemplateEditor.Message) =>
  Message.GotTemplateEditorMessage({ message })

export const openEditor = (record: TemplateVersionRecord, from = editorModel) =>
  [
    clickedLinkTo(`/templates/${record.templateId}/v/${record.version}`),
    editorMessage(TemplateEditor.loadedVersion(scopeOf(record), record)),
  ].reduce((model, message) => update(model, message).model, from)

export const SUMMARIES: ReadonlyArray<TemplateSummary> = [
  {
    id: INTAKE_TEMPLATE.id,
    name: INTAKE_TEMPLATE.name,
    shortName: INTAKE_TEMPLATE.shortName,
    builtIn: true,
    latestVersion: 1,
    publishedVersion: 1,
    hasDraft: false,
    retired: false,
  },
  {
    id: 'tpl-draft',
    name: 'A template in progress',
    shortName: 'progress',
    builtIn: false,
    latestVersion: 1,
    hasDraft: true,
    retired: false,
  },
  {
    id: 'tpl-old',
    name: 'An old template',
    shortName: 'old',
    builtIn: false,
    latestVersion: 2,
    hasDraft: false,
    retired: true,
  },
]

export const listModel = [
  clickedLinkTo('/templates'),
  Message.GotTemplatesMessage({ message: Templates.loadedTemplates(SUMMARIES) }),
].reduce((model, message) => update(model, message).model, editorModel)
