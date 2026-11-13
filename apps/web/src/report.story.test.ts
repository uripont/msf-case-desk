import { Option } from 'effect'
import { Command, given, message, model, story } from 'foldkit/story'
import { describe, expect, test } from 'vitest'

import {
  INTAKE_TEMPLATE,
  type Template,
  contentOfKey,
  endState,
  numberSections,
  sectionStates,
} from '@case-desk/domain'

import { clickedLinkTo, clickedPage } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import { Failure } from './quoroom/failure'
import * as Report from './quoroom/report'
import * as Reports from './quoroom/reports'
import {
  REPORT_ID,
  SECOND_AUTHOR,
  TEMPLATES,
  detailOf,
  loadedReport,
} from './report.fixtures'

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
        loaded: loadedReport(template, options),
      }),
    ),
  ].reduce((model, message) => update(model, message).model, authorModel)

const JURISDICTION = 'jurisdiction-materiality/jurisdiction'

const choose = (optionId: string) =>
  Option.some({ type: 'select' as const, optionIds: [optionId] })

const changed = (sectionKey: string, itemId: string, optionId: string) =>
  reportMessage(
    Report.Message.ChangedItem({
      sectionKey,
      itemId,
      maybeValue: choose(optionId),
    }),
  )

const intake = () => reportModelFor(INTAKE_TEMPLATE)

describe('entering a report', () => {
  test('opening a report loads it', () => {
    const step = update(authorModel, {
      ...clickedPage('Reports'),
    })
    expect((step.commands ?? []).map(command => command.name)).toContain(
      Reports.LoadUnits.name,
    )
  })

  test('the loaded report is shown with the first section selected', () => {
    const loaded = intake()
    expect(loaded.report.load._tag).toBe('Loaded')
    expect(loaded.report.save._tag).toBe('Saved')
    const template = Option.getOrThrow(loaded.report.maybeTemplate)
    const rows = Report.outlineOf(template, loaded.report).rows
    expect(Report.selectedKeyOf(loaded.report, rows)).toBe(rows[0]?.key)
  })
})

describe('numbering and states follow the domain, for every template', () => {
  test.each(TEMPLATES.map(template => [template.id, template] as const))(
    '%s',
    (_id, template) => {
      const outline = Report.outlineOf(template, {
        ...Report.initialModel,
        contents: {},
      })
      expect(outline.rows).toEqual(numberSections(template, { sections: {} }))
      expect(outline.states).toEqual(sectionStates(template, { sections: {} }))
      expect(outline.end.ended).toBe(false)
    },
  )
})

type Step = ReturnType<typeof update>

const namesOf = (step: Step): ReadonlyArray<string> =>
  (step.commands ?? []).map(command => command.name)

const run = (
  start: ReturnType<typeof intake>,
  messages: ReadonlyArray<Parameters<typeof update>[1]>,
): Step =>
  messages.reduce<Step>((previous, next) => update(previous.model, next), {
    model: start,
  })

const MATERIALITY = 'jurisdiction-materiality/materiality'

describe('editing and saving', () => {
  test('a change is stored, marks the section, and starts one save', () => {
    const step = run(intake(), [
      changed(JURISDICTION, 'jurisdiction-answer', 'yes'),
    ])
    expect(namesOf(step)).toEqual([Report.SaveSection.name])
    expect(step.model.report.save).toEqual(
      Report.SaveStatus.Saving({ sectionId: 'jurisdiction-materiality' }),
    )
    expect(
      contentOfKey(step.model.report.contents, JURISDICTION).values[
        'jurisdiction-answer'
      ],
    ).toEqual({ type: 'select', optionIds: ['yes'] })
  })

  test('a second change while a save is in flight sends nothing more', () => {
    const first = run(intake(), [
      changed(JURISDICTION, 'jurisdiction-answer', 'yes'),
    ])
    const second = update(
      first.model,
      changed(MATERIALITY, 'materiality-answer', 'yes'),
    )
    expect(namesOf(second)).toEqual([])
    expect(second.model.report.save._tag).toBe('Saving')
  })

  test('the saved counter is kept when the save succeeds', () => {
    const first = run(intake(), [
      changed(JURISDICTION, 'jurisdiction-answer', 'yes'),
    ])
    const done = update(
      first.model,
      reportMessage(
        Report.Message.SucceededSaveSection({
          sectionId: 'jurisdiction-materiality',
          saveCounter: 1,
        }),
      ),
    )
    expect(done.model.report.saveCounter).toBe(1)
    expect(done.model.report.save._tag).toBe('Saved')
    expect(done.model.report.dirtySectionIds).toEqual([])
    expect(namesOf(done)).toEqual([])
  })

  test('a failed save keeps the section dirty and a retry saves it again', () => {
    const first = run(intake(), [
      changed(JURISDICTION, 'jurisdiction-answer', 'yes'),
    ])
    const failed = update(
      first.model,
      reportMessage(
        Report.Message.FailedSaveSection({
          sectionId: 'jurisdiction-materiality',
          failure: Failure.Unavailable(),
        }),
      ),
    )
    expect(failed.model.report.save._tag).toBe('Failed')
    expect(failed.model.report.dirtySectionIds).toEqual([
      'jurisdiction-materiality',
    ])
    const retried = update(
      failed.model,
      reportMessage(Report.Message.ClickedRetrySave()),
    )
    expect(namesOf(retried)).toEqual([Report.SaveSection.name])
  })

  test('a save refused as stale leaves the work on screen', () => {
    const first = run(intake(), [
      changed(JURISDICTION, 'jurisdiction-answer', 'yes'),
    ])
    const failed = update(
      first.model,
      reportMessage(
        Report.Message.FailedSaveSection({
          sectionId: 'jurisdiction-materiality',
          failure: Failure.Refused({ message: 'Saved from another tab.' }),
        }),
      ),
    )
    expect(failed.model.report.save._tag).toBe('Failed')
    expect(
      contentOfKey(failed.model.report.contents, JURISDICTION).values[
        'jurisdiction-answer'
      ],
    ).toBeDefined()
  })
})

describe('branching is live', () => {
  test('the end answer ends the report, and another answer restores it', () => {
    const ended = [changed(JURISDICTION, 'jurisdiction-answer', 'no')].reduce(
      (current, next) => update(current, next).model,
      intake(),
    )
    const template = INTAKE_TEMPLATE
    expect(endState(template, { sections: ended.report.contents }).ended).toBe(
      true,
    )
    const restored = update(
      ended,
      changed(JURISDICTION, 'jurisdiction-answer', 'yes'),
    ).model
    expect(
      endState(template, { sections: restored.report.contents }).ended,
    ).toBe(false)
  })
})

describe('what can be edited', () => {
  const template = INTAKE_TEMPLATE
  const edit = ['edit'] as const

  test('a drafting report is editable by an author with edit', () => {
    expect(Report.editability(template, 'drafting', edit, 'summary').kind).toBe(
      'editable',
    )
  })

  test('an archived report is read only', () => {
    expect(Report.editability(template, 'archived', edit, 'summary').kind).toBe(
      'read_only',
    )
  })

  test('without the edit permission nothing is editable', () => {
    expect(Report.editability(template, 'drafting', [], 'summary').kind).toBe(
      'read_only',
    )
  })

  test('only the conclusion is editable while concluding, and not before', () => {
    const conclusion = template.conclusion?.id
    expect(conclusion).toBeDefined()
    expect(
      Report.editability(template, 'concluding', edit, conclusion ?? '').kind,
    ).toBe('editable')
    expect(
      Report.editability(template, 'concluding', edit, 'summary').kind,
    ).toBe('read_only')
    expect(
      Report.editability(template, 'drafting', edit, conclusion ?? '').kind,
    ).toBe('read_only')
  })
})

describe('co-authors', () => {
  test('only existing active authors of the unit who are not yet authors are offered', () => {
    const loaded = intake().report
    expect(
      Report.authorCandidates(loaded).map(member => member.accountId),
    ).toEqual([SECOND_AUTHOR.accountId])
  })

  test('adding one sends the command and then lists them', () => {
    story(
      update,
      given(intake()),
      message(
        reportMessage(
          Report.Message.SelectedCoAuthor({ value: SECOND_AUTHOR.accountId }),
        ),
      ),
      message(reportMessage(Report.Message.SubmittedCoAuthor())),
      Command.expectHas(Report.AddCoAuthor),
      Command.resolve(
        Report.AddCoAuthor,
        Report.Message.SucceededAddCoAuthor({
          account: { id: SECOND_AUTHOR.accountId, name: SECOND_AUTHOR.name },
        }),
      ),
      model(next => {
        expect(
          Option.getOrThrow(next.report.maybeDetail).authors.map(a => a.id),
        ).toContain(SECOND_AUTHOR.accountId)
        expect(Report.authorCandidates(next.report)).toEqual([])
      }),
    )
  })
})

describe('the reports list', () => {
  const summary = (id: string, caseFileId: string) => ({
    ...detailOf(INTAKE_TEMPLATE).summary,
    id,
    caseFile: {
      ...detailOf(INTAKE_TEMPLATE).summary.caseFile,
      id: caseFileId,
    },
  })

  const reports = Array.from({ length: 23 }, (_, index) =>
    summary(`r-${index}`, index % 2 === 0 ? 'cf-a' : 'cf-b'),
  )

  const listed = {
    ...Reports.initialModel,
    selectedUnit: 'unit-1',
    reports,
    caseFiles: [
      { id: 'cf-a', unit: 'unit-1', reference: 'SYN-A', title: 'A' },
      { id: 'cf-b', unit: 'unit-1', reference: 'SYN-B', title: 'B' },
    ],
  }

  test('ten reports a page', () => {
    expect(Reports.pageOf(listed)).toHaveLength(10)
    expect(Reports.pageCountOf(reports.length)).toBe(3)
  })

  test('the case file filter narrows the list and returns to the first page', () => {
    const next = Reports.update(
      { ...listed, page: 2 },
      Reports.Message.SelectedCaseFileFilter({ value: 'cf-b' }),
    ).model
    expect(next.page).toBe(0)
    expect(Reports.visibleReportsOf(next)).toHaveLength(11)
  })

  test('the page never runs past the last one', () => {
    const last = Reports.update(
      { ...listed, page: 2 },
      Reports.Message.ClickedNextPage(),
    ).model
    expect(last.page).toBe(2)
  })

  test('the state filter asks the server again', () => {
    const step = Reports.update(
      listed,
      Reports.Message.SelectedStateFilter({ value: 'drafting' }),
    )
    expect((step.commands ?? []).map(command => command.name)).toEqual([
      Reports.LoadReports.name,
    ])
  })

  test('a new case file needs its reference and title before it is sent', () => {
    const step = Reports.update(
      {
        ...listed,
        templates: [
          {
            id: 'ethics-intake',
            version: 1,
            name: 'Intake',
            shortName: 'intake',
            caseReferenceLabel: 'Integrity Line reference',
          },
        ],
        templateChoice: 'ethics-intake@1',
      },
      Reports.Message.SubmittedReport(),
    )
    expect(step.commands ?? []).toEqual([])
    expect(step.model.createForm._tag).toBe('Invalid')
  })

  test('a report is created from the chosen template version', () => {
    const ready = {
      ...listed,
      templates: [
        {
          id: 'ethics-intake',
          version: 1,
          name: 'Intake',
          shortName: 'intake',
          caseReferenceLabel: 'Integrity Line reference',
        },
      ],
      templateChoice: 'ethics-intake@1',
      newReference: 'SYN-9',
      newTitle: 'Synthetic title',
    }
    const step = Reports.update(ready, Reports.Message.SubmittedReport())
    expect((step.commands ?? []).map(command => command.name)).toEqual([
      Reports.CreateReport.name,
    ])
    expect(step.model.createForm._tag).toBe('Submitting')
  })

  test('retitling a case file replaces it in the list', () => {
    const renaming = Reports.update(
      listed,
      Reports.Message.ClickedRename({ caseFileId: 'cf-a' }),
    ).model
    expect(Option.isSome(renaming.maybeRenaming)).toBe(true)
    const done = Reports.update(
      renaming,
      Reports.Message.SucceededUpdateCaseFile({
        caseFile: {
          id: 'cf-a',
          unit: 'unit-1',
          reference: 'SYN-A',
          title: 'Renamed',
        },
      }),
    ).model
    expect(done.caseFiles[0]?.title).toBe('Renamed')
    expect(done.reports[0]?.caseFile.title).toBe('Renamed')
    expect(Option.isNone(done.maybeRenaming)).toBe(true)
  })
})

describe('the report id', () => {
  test('the screen is entered for the id in the address', () => {
    expect(intake().report.reportId).toBe(REPORT_ID)
  })

  test('the loaded fixture carries the template', () => {
    expect(loadedReport(INTAKE_TEMPLATE).template.id).toBe('ethics-intake')
  })
})
