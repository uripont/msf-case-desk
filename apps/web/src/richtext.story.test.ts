import { Option } from 'effect'
import { describe, expect, test } from 'vitest'

import { INTAKE_TEMPLATE, type RichTextDoc } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import { serializeRichText } from './quoroom/editor/richText'
import * as Report from './quoroom/report'
import { REPORT_ID, loadedReport } from './report.fixtures'

const reportMessage = (message: Report.Message) =>
  Message.GotReportMessage({ message })

const loaded = (options: Parameters<typeof loadedReport>[1] = {}) => {
  const opened = update(authorModel, clickedLinkTo(`/r/${REPORT_ID}`))
  return update(
    opened.model,
    reportMessage(
      Report.Message.SucceededLoadReport({
        loaded: loadedReport(INTAKE_TEMPLATE, options),
      }),
    ),
  )
}

const commandNames = (step: { commands?: ReadonlyArray<{ name: string }> }) =>
  (step.commands ?? []).map(command => command.name)

const select = (model: ReturnType<typeof update>['model'], key: string) =>
  update(model, reportMessage(Report.Message.SelectedSection({ key })))

const SUMMARY = 'summary'
const ITEM = 'summary-text'

const DOC: RichTextDoc = {
  type: 'doc',
  content: [
    {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: 'Facts' }],
    },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Synthetic ' },
        { type: 'text', text: 'text', marks: [{ type: 'bold' }] },
      ],
    },
  ],
}

const change = (content: string, version: number) =>
  reportMessage(
    Report.Message.ChangedRichText({
      sectionKey: SUMMARY,
      steps: [],
      itemId: ITEM,
      content,
      version,
    }),
  )

describe('loading the editor', () => {
  test('nothing is requested while no rich-text section is shown', () => {
    const opened = loaded()
    expect(commandNames(opened)).not.toContain(Report.LoadEditor.name)
    expect(opened.model.report.editor._tag).toBe('NotLoaded')
  })

  test('showing a rich-text section requests it once', () => {
    const first = select(loaded().model, SUMMARY)
    expect(commandNames(first)).toContain(Report.LoadEditor.name)
    expect(first.model.report.editor._tag).toBe('Loading')
    const again = select(first.model, SUMMARY)
    expect(commandNames(again)).not.toContain(Report.LoadEditor.name)
  })

  test('the editor is shown as ready after it loaded, and a failure can be retried', () => {
    const asked = select(loaded().model, SUMMARY)
    const ready = update(
      asked.model,
      reportMessage(Report.Message.SucceededLoadEditor()),
    )
    expect(ready.model.report.editor._tag).toBe('Ready')
    const failed = update(
      asked.model,
      reportMessage(Report.Message.FailedLoadEditor()),
    )
    expect(failed.model.report.editor._tag).toBe('Failed')
    const retried = update(
      failed.model,
      reportMessage(Report.Message.ClickedRetryLoadEditor()),
    )
    expect(retried.model.report.editor._tag).toBe('Loading')
    expect(commandNames(retried)).toContain(Report.LoadEditor.name)
  })

  test('a report the author may only read never loads the editor', () => {
    const readOnly = loaded({ permissions: [] })
    expect(commandNames(select(readOnly.model, SUMMARY))).not.toContain(
      Report.LoadEditor.name,
    )
  })
})

describe('changes from the editor', () => {
  test('a change is stored and saved through the section save', () => {
    const step = update(loaded().model, change(serializeRichText(DOC), 3))
    expect(commandNames(step)).toContain(Report.SaveSection.name)
    expect(step.model.report.contents[SUMMARY]?.values[ITEM]).toEqual({
      type: 'rich_text',
      doc: DOC,
    })
    expect(step.model.report.editorVersions[`${SUMMARY}/${ITEM}`]).toBe(3)
  })

  test('the saved content is the canonical form', () => {
    const noisy = JSON.stringify({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
            { type: 'text', text: '' },
          ],
        },
      ],
    })
    const step = update(loaded().model, change(noisy, 1))
    expect(step.model.report.contents[SUMMARY]?.values[ITEM]).toEqual({
      type: 'rich_text',
      doc: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'ab' }] },
        ],
      },
    })
  })

  test('an empty document removes the value, so content stays sparse', () => {
    const written = update(loaded().model, change(serializeRichText(DOC), 1))
    const cleared = update(
      written.model,
      change(
        JSON.stringify({ type: 'doc', content: [{ type: 'paragraph' }] }),
        2,
      ),
    )
    expect(cleared.model.report.contents[SUMMARY]?.values[ITEM]).toBeUndefined()
  })

  test.each([
    ['text that is not JSON', 'not json'],
    [
      'an unknown node',
      JSON.stringify({ type: 'doc', content: [{ type: 'codeBlock' }] }),
    ],
    [
      'a link to javascript',
      JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: 'x',
                marks: [
                  { type: 'link', attrs: { href: 'javascript:alert(1)' } },
                ],
              },
            ],
          },
        ],
      }),
    ],
    [
      'an unknown attribute',
      JSON.stringify({
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { style: 'x' } }],
      }),
    ],
  ])('%s is refused and nothing is saved', (_name, content) => {
    const before = loaded()
    const step = update(before.model, change(content, 1))
    expect(commandNames(step)).not.toContain(Report.SaveSection.name)
    expect(Option.isSome(step.model.report.maybeRefusal)).toBe(true)
    expect(step.model.report.contents).toEqual(before.model.report.contents)
  })

  test('a good change after a refused one clears the notice', () => {
    const refused = update(loaded().model, change('nope', 1))
    const fine = update(refused.model, change(serializeRichText(DOC), 2))
    expect(Option.isNone(fine.model.report.maybeRefusal)).toBe(true)
  })
})

describe('selection reporting', () => {
  const range = (from: number, to: number, text: string) =>
    reportMessage(
      Report.Message.SelectedRichTextRange({
        sectionKey: SUMMARY,
        itemId: ITEM,
        from,
        to,
        text,
      }),
    )

  test('a selected range is kept with its quoted text', () => {
    const step = update(loaded().model, range(2, 9, 'Synthet'))
    expect(step.model.report.maybeSelection).toEqual(
      Option.some({
        sectionKey: SUMMARY,
        itemId: ITEM,
        from: 2,
        to: 9,
        text: 'Synthet',
      }),
    )
  })

  test('a collapsed caret clears it, and so does leaving the section', () => {
    const selected = update(loaded().model, range(2, 9, 'Synthet'))
    expect(
      Option.isNone(
        update(selected.model, range(4, 4, '')).model.report.maybeSelection,
      ),
    ).toBe(true)
    expect(
      Option.isNone(
        select(selected.model, 'case-details').model.report.maybeSelection,
      ),
    ).toBe(true)
  })
})
