import { Option } from 'effect'

import {
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type Permission,
  type ReportDetail,
  type ReportState,
  type SectionContents,
  type Template,
} from '@case-desk/domain'
import { PANEL_TEMPLATE } from '@case-desk/domain/testing/templates'

import { AUTHOR_ME, SYNTHETIC_UNIT } from './quoroom.fixtures'
import * as Report from './quoroom/report'

// NOTE: Synthetic reports for the drafting screen, built from the three
// templates of the domain so the screen is tested against what the templates
// really contain.
export const TEMPLATES: ReadonlyArray<Template> = [
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  PANEL_TEMPLATE,
]

export const REPORT_ID = 'report-1'

// NOTE: The scope of the first entry into a report from an empty screen.
export const SCOPE = { reportId: REPORT_ID, generation: 1, epoch: 0 }

export const FIRST_AUTHOR = { id: 'account-1', name: AUTHOR_ME.name }

export const SECOND_AUTHOR = {
  accountId: 'account-2',
  name: 'Second Author',
  email: 'second.author@case-desk.test',
  isAuthor: true,
  isReviewer: false,
  active: true,
}

export const detailOf = (
  template: Template,
  state: ReportState = 'drafting',
  permissions: ReadonlyArray<Permission> = ['edit', 'manage_people'],
): typeof ReportDetail.Type => ({
  summary: {
    id: REPORT_ID,
    caseFile: {
      id: 'case-file-1',
      unit: SYNTHETIC_UNIT.id,
      reference: 'SYN-0001',
      title: 'Synthetic case file',
    },
    templateId: template.id,
    templateVersion: template.version,
    templateName: template.name,
    state,
    latestDraft: 0,
    createdAt: 1_000,
  },
  myRoleId: template.roles[0]?.id ?? 'authors',
  permissions: [...permissions],
  authors: [FIRST_AUTHOR],
})

// NOTE: 2026-03-04 14:32 UTC, a fixed time for the save text.
export const SAVED_AT = Date.UTC(2026, 2, 4, 14, 32)

export const loadedReport = (
  template: Template,
  options: Readonly<{
    contents?: SectionContents
    state?: ReportState
    permissions?: ReadonlyArray<Permission>
    saveCounter?: number
  }> = {},
): Report.LoadedReport => ({
  detail: detailOf(template, options.state, options.permissions),
  template,
  unitName: SYNTHETIC_UNIT.name,
  contents: options.contents ?? {},
  people: [
    {
      id: 'person-1',
      name: 'Synthetic Person',
      label: 'Person A',
      aliases: [],
    },
    {
      id: 'person-2',
      name: 'Other Synthetic Person',
      label: 'Person B',
      aliases: [],
    },
  ],
  saveCounter: options.saveCounter ?? 0,
  savedAt: SAVED_AT,
  copy: {
    baseDraft: 0,
    latestDraft: 0,
    behind: false,
    hasUnsharedChanges: false,
  },
  maybeImageUsage: Option.none(),
  myId: FIRST_AUTHOR.id,
  drafting: [],
  unitMembers: [
    {
      accountId: FIRST_AUTHOR.id,
      name: FIRST_AUTHOR.name,
      email: 'first.author@case-desk.test',
      isAuthor: true,
      isReviewer: false,
      active: true,
    },
    SECOND_AUTHOR,
  ],
})

// NOTE: The facts of the server's section read after a save was refused as
// stale: the saved section differs from what was sent, so the copy really
// changed in another tab.
export const staleSaveFacts = (sectionId: string) => ({
  scope: SCOPE,
  sectionId,
  sent: { values: {}, sections: {} },
  saved: {
    notApplicable: { reason: 'Changed elsewhere' },
    values: {},
    sections: {},
  },
  saveCounter: 3,
  savedAt: SAVED_AT,
})
