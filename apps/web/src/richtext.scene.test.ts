import {
  Command,
  CustomElement,
  click,
  expect,
  given,
  role,
  scene,
  selector,
  text,
} from 'foldkit/scene'
import { describe, test } from 'vitest'

import { INTAKE_TEMPLATE } from '@case-desk/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import { serializeRichText } from './quoroom/editor/richText'
import { editorElement } from './quoroom/editor/spec'
import * as Report from './quoroom/report'
import { REPORT_ID, SAVED_AT, loadedReport } from './report.fixtures'
import { view } from './view'

const reportModelFor = (options: Parameters<typeof loadedReport>[1] = {}) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    Message.GotReportMessage({
      message: Report.Message.SucceededLoadReport({
        loaded: loadedReport(INTAKE_TEMPLATE, options),
      }),
    }),
  ].reduce((model, message) => update(model, message).model, authorModel)

const focused = Command.resolve(
  Report.FocusSectionHeading,
  Report.Message.CompletedFocusSectionHeading(),
)

const editorLoaded = Command.resolve(
  Report.LoadEditor,
  Report.Message.SucceededLoadEditor(),
)

const openSummary = click(role('button', { name: /Summary of the complaint/ }))

describe('the editor slot', () => {
  test('the editor tag is rendered only after the editor has loaded', () => {
    scene(
      { update, view },
      given(reportModelFor()),
      expect(selector('quoroom-editor')).toBeAbsent(),
      openSummary,
      focused,
      expect(selector('quoroom-editor')).toBeAbsent(),
      expect(text('Loading the text editor.')).toExist(),
      editorLoaded,
      expect(selector('quoroom-editor')).toExist(),
    )
  })

  test('a change from the element is saved, and the save state is shown', () => {
    scene(
      { update, view },
      given(reportModelFor()),
      openSummary,
      focused,
      editorLoaded,
      CustomElement.emit(editorElement, selector('quoroom-editor'), 'change', {
        content: serializeRichText({
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Synthetic text' }],
            },
          ],
        }),
        version: 1,
      }),
      Command.resolve(
        Report.SaveSection,
        Report.Message.SucceededSaveSection({
          sectionId: 'summary',
          saveCounter: 1,
          savedAt: SAVED_AT,
        }),
      ),
      expect(text(/Saved at \d\d:\d\d/)).toExist(),
    )
  })

  test('a change the schema refuses shows a notice and saves nothing', () => {
    scene(
      { update, view },
      given(reportModelFor()),
      openSummary,
      focused,
      editorLoaded,
      CustomElement.emit(editorElement, selector('quoroom-editor'), 'change', {
        content: JSON.stringify({
          type: 'doc',
          content: [{ type: 'codeBlock' }],
        }),
        version: 1,
      }),
      expect(text(/uses something Quoroom cannot store/)).toExist(),
      Command.expectNone(),
    )
  })

  test('a failed load offers a retry', () => {
    scene(
      { update, view },
      given(reportModelFor()),
      openSummary,
      focused,
      Command.resolve(Report.LoadEditor, Report.Message.FailedLoadEditor()),
      expect(text(/text editor could not be loaded/)).toExist(),
      click(role('button', { name: 'Try again' })),
      editorLoaded,
      expect(selector('quoroom-editor')).toExist(),
    )
  })
})

describe('reading rich text without the editor', () => {
  const doc = {
    type: 'doc' as const,
    content: [
      {
        type: 'heading' as const,
        attrs: { level: 1 },
        content: [{ type: 'text' as const, text: 'Heading one' }],
      },
      {
        type: 'paragraph' as const,
        content: [
          {
            type: 'text' as const,
            text: 'a link',
            marks: [
              { type: 'link' as const, attrs: { href: 'https://example.org' } },
            ],
          },
        ],
      },
      {
        type: 'bulletList' as const,
        content: [
          {
            type: 'listItem' as const,
            content: [
              {
                type: 'paragraph' as const,
                content: [{ type: 'text' as const, text: 'first item' }],
              },
            ],
          },
        ],
      },
      {
        type: 'table' as const,
        content: [
          {
            type: 'tableRow' as const,
            content: [
              {
                type: 'tableHeader' as const,
                content: [
                  {
                    type: 'paragraph' as const,
                    content: [{ type: 'text' as const, text: 'Column' }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: 'figure' as const,
        attrs: { imageId: 'img-1', alt: 'A picture', safeToShare: false },
        content: [{ type: 'text' as const, text: 'A caption' }],
      },
    ],
  }

  test('a read-only report shows the document and never loads the editor', () => {
    scene(
      { update, view },
      given(
        reportModelFor({
          permissions: [],
          contents: {
            summary: {
              values: { 'summary-text': { type: 'rich_text', doc } },
              sections: {},
            },
          },
        }),
      ),
      openSummary,
      focused,
      expect(text('Heading one')).toExist(),
      expect(role('link', { name: 'a link' })).toHaveAttr(
        'href',
        'https://example.org',
      ),
      expect(text('first item')).toExist(),
      expect(text('Column')).toExist(),
      expect(text('A caption')).toExist(),
      expect(selector('quoroom-editor')).toBeAbsent(),
      Command.expectNone(),
    )
  })
})
