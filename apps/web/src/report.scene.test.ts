import { Option } from 'effect'
import {
  Command,
  change,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
  type,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  INVESTIGATION_TEMPLATE,
  type Section,
  type Template,
  sectionOfKey,
} from '@quoroom/domain'
import { PANEL_TEMPLATE } from '@quoroom/domain/testing/templates'

import { atPage, clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { SYNTHETIC_UNIT, authorModel } from './quoroom.fixtures'
import * as Report from './quoroom/report'
import * as Reports from './quoroom/reports'
import {
  REPORT_ID,
  SAVED_AT,
  SCOPE,
  SECOND_AUTHOR,
  detailOf,
  loadedReport,
} from './report.fixtures'
import { view } from './view'

const reportMessage = (message: Report.Message) =>
  Message.GotReportMessage({ message })

const reportModelFor = (
  template: Template,
  options: Parameters<typeof loadedReport>[1] = {},
) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    reportMessage(
      Report.Message.SucceededLoadReport({
        scope: SCOPE,
        loaded: loadedReport(template, options),
      }),
    ),
  ].reduce((model, message) => update(model, message).model, authorModel)

const focused = Command.resolve(
  Report.FocusSectionHeading,
  Report.Message.CompletedFocusSectionHeading(),
)

const editorLoaded = Command.resolve(
  Report.LoadEditor,
  Report.Message.SucceededLoadEditor(),
)

const reportsMessage = (message: Reports.Message) =>
  Message.GotReportsMessage({ message })

const caseFiles = [
  {
    id: 'cf-a',
    unit: SYNTHETIC_UNIT.id,
    reference: 'SYN-A',
    title: 'First file',
  },
  {
    id: 'cf-b',
    unit: SYNTHETIC_UNIT.id,
    reference: 'SYN-B',
    title: 'Second file',
  },
]

const templates = [
  {
    id: 'ethics-intake',
    version: 1,
    name: 'Intake and initial assessment',
    shortName: 'intake',
    caseReferenceLabel: 'Integrity Line reference',
  },
]

const listedModel = [
  reportsMessage(
    Reports.Message.SucceededLoadUnits({ units: [SYNTHETIC_UNIT] }),
  ),
  reportsMessage(
    Reports.Message.SucceededLoadReports({
      unit: SYNTHETIC_UNIT.id,
      maybeState: Option.none(),
      reports: [
        {
          ...detailOf(INTAKE_TEMPLATE).summary,
          caseFile: caseFiles[0] ?? detailOf(INTAKE_TEMPLATE).summary.caseFile,
        },
      ],
      caseFiles,
      templates,
    }),
  ),
].reduce(
  (model, next) => update(model, next).model,
  atPage(authorModel, 'Reports'),
)

describe('the reports screen', () => {
  test('lists reports with a link to each, and the case files', () => {
    scene(
      { update, view },
      given(listedModel),
      expect(role('heading', { name: 'Your reports' })).toExist(),
      expect(role('link', { name: 'SYN-A: First file' })).toHaveAttr(
        'href',
        '/r/report-1',
      ),
      expect(role('heading', { name: 'Case files' })).toExist(),
      expect(role('button', { name: 'Rename case file SYN-B' })).toExist(),
    )
  })

  test('a case file is retitled', () => {
    scene(
      { update, view },
      given(listedModel),
      click(role('button', { name: 'Rename case file SYN-B' })),
      type(role('textbox', { name: 'New title' }), 'Renamed file'),
      click(role('button', { name: 'Save title' })),
      Command.resolve(
        Reports.UpdateCaseFile,
        Reports.Message.SucceededUpdateCaseFile({
          caseFile: { ...caseFiles[1]!, title: 'Renamed file' },
        }),
      ),
      expect(text('Renamed file')).toExist(),
    )
  })

  test('a report starts from a template, on a new case file', () => {
    scene(
      { update, view },
      given(listedModel),
      type(role('textbox', { name: 'Integrity Line reference' }), 'SYN-9'),
      type(role('textbox', { name: 'Case file title' }), 'Synthetic new file'),
      click(role('button', { name: 'Create report' })),
      Command.resolve(
        Reports.CreateReport,
        Reports.Message.SucceededCreateReport({
          report: {
            ...detailOf(INTAKE_TEMPLATE).summary,
            id: 'report-9',
            caseFile: {
              id: 'cf-new',
              unit: SYNTHETIC_UNIT.id,
              reference: 'SYN-9',
              title: 'Synthetic new file',
            },
          },
        }),
      ),
      Command.resolve(
        Reports.LoadReports,
        Reports.Message.SucceededLoadReports({
          unit: SYNTHETIC_UNIT.id,
          maybeState: Option.none(),
          reports: [],
          caseFiles,
          templates,
        }),
      ),
      expect(role('link', { name: 'Open report SYN-9' })).toHaveAttr(
        'href',
        '/r/report-9',
      ),
    )
  })
})

describe('the navigator', () => {
  test('intake: front matter is not numbered, the rest are, and subsections are listed', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      expect(role('navigation', { name: 'Sections' })).toExist(),
      expect(role('button', { name: /Case details/ })).toExist(),
      expect(role('button', { name: /Summary of the complaint/ })).toExist(),
      expect(
        role('button', { name: /Jurisdiction and materiality/ }),
      ).toExist(),
    )
  })

  test.each([
    ['investigation', INVESTIGATION_TEMPLATE],
    ['panel', PANEL_TEMPLATE],
  ] as const)(
    '%s: the report title and every top-level section are shown',
    (_name, template) => {
      scene(
        { update, view },
        given(reportModelFor(template)),
        expect(role('heading', { level: 1, name: template.name })).toExist(),
        ...template.sections.map(section =>
          expect(role('button', { name: new RegExp(section.title) })).toExist(),
        ),
      )
    },
  )
})

describe('structured fields', () => {
  test('text, date, select with codes, people and the case value are all shown in case details', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      expect(role('textbox', { name: /Investigator/ })).toExist(),
      expect(text(/Date the project received the case/)).toExist(),
      expect(role('checkbox', { name: /Known/ })).toExist(),
      expect(
        role('group', { name: /Subject or subjects, if known/ }),
      ).toExist(),
      expect(text('SYN-0001')).toExist(),
    )
  })

  test('typing in a text field saves the section', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      type(role('textbox', { name: /Investigator/ }), 'Synthetic Investigator'),
      Command.resolve(
        Report.SaveSection,
        Report.Message.SucceededSaveSection({
          scope: SCOPE,
          sectionId: 'case-details',
          saveCounter: 1,
          savedAt: SAVED_AT,
        }),
      ),
      expect(text(/Saved at \d\d:\d\d/)).toExist(),
    )
  })

  test('instruction text is shown as guidance', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      click(role('button', { name: /Jurisdiction and materiality/ })),
      focused,
      expect(text(/If the answer to either question is no/)).toExist(),
    )
  })

  test('rich text items show the editor once it is loaded', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      click(role('button', { name: /Summary of the complaint/ })),
      focused,
      expect(text(/A short account of the complaint/)).toExist(),
      expect(text('Loading the text editor.')).toExist(),
      editorLoaded,
      expect(selector('quoroom-editor')).toExist(),
    )
  })
})

describe('branching', () => {
  test('answering no ends the report, and answering yes restores it', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      click(role('button', { name: /Jurisdiction and materiality/ })),
      focused,
      click(role('button', { name: /Jurisdiction, / })),
      focused,
      editorLoaded,
      click(role('radio', { name: /No/ })),
      Command.resolve(
        Report.SaveSection,
        Report.Message.SucceededSaveSection({
          scope: SCOPE,
          sectionId: 'jurisdiction-materiality',
          saveCounter: 1,
          savedAt: SAVED_AT,
        }),
      ),
      expect(text(/The report ends here/)).toExist(),
      click(role('radio', { name: /Yes/ })),
      Command.resolve(
        Report.SaveSection,
        Report.Message.SucceededSaveSection({
          scope: SCOPE,
          sectionId: 'jurisdiction-materiality',
          saveCounter: 2,
          savedAt: SAVED_AT,
        }),
      ),
      expect(text(/The report ends here/)).toBeAbsent(),
    )
  })
})

describe('co-authors', () => {
  test('an author is chosen from the unit and added', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE)),
      change(
        role('combobox', { name: 'Add a co-author' }),
        SECOND_AUTHOR.accountId,
      ),
      click(role('button', { name: 'Add co-author' })),
      Command.resolve(
        Report.AddCoAuthor,
        Report.Message.SucceededAddCoAuthor({
          scope: SCOPE,
          account: { id: SECOND_AUTHOR.accountId, name: SECOND_AUTHOR.name },
        }),
      ),
      expect(text(/Second Author is now an author/)).toExist(),
    )
  })
})

describe('read only reports', () => {
  test('an archived report cannot be changed', () => {
    scene(
      { update, view },
      given(reportModelFor(INTAKE_TEMPLATE, { state: 'archived' })),
      expect(text(/This report is archived/)).toExist(),
      expect(role('textbox', { name: /Investigator/ })).toBeDisabled(),
    )
  })
})

const structuredItemLabels = (section: Section): ReadonlyArray<string> =>
  section.items.flatMap(item =>
    item.type === 'rich_text' || item.type === 'repeated' ? [] : [item.label],
  )

describe('every structured item of every template has a field', () => {
  test.each(
    [INTAKE_TEMPLATE, INVESTIGATION_TEMPLATE, PANEL_TEMPLATE].map(
      template => [template.id, template] as const,
    ),
  )('%s', (_id, template) => {
    const start = reportModelFor(template)
    const rows = Report.outlineOf(template, start.report).rows.filter(
      row => row.entryId === undefined,
    )
    rows.forEach(row => {
      const section = sectionOfKey(template, row.key)
      const labels = section === undefined ? [] : structuredItemLabels(section)
      const selected = update(
        start,
        reportMessage(Report.Message.SelectedSection({ key: row.key })),
      ).model
      scene(
        { update, view },
        given(selected),
        ...labels.map(itemLabel => expect(text(itemLabel)).toExist()),
      )
    })
  })
})
