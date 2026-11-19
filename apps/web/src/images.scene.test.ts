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

import { INTAKE_TEMPLATE } from '@quoroom/domain'

import { clickedLinkTo } from './fixtures'
import { Message, update } from './main'
import { authorModel } from './quoroom.fixtures'
import { editorElement } from './quoroom/editor/spec'
import * as Report from './quoroom/report'
import { REPORT_ID, SCOPE, loadedReport } from './report.fixtures'
import { view } from './view'

const reportModelFor = (options: Parameters<typeof loadedReport>[1] = {}) =>
  [
    clickedLinkTo(`/r/${REPORT_ID}`),
    Message.GotReportMessage({
      message: Report.Message.SucceededLoadReport({
        scope: SCOPE,
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

const figureDoc = (safeToShare: boolean) => ({
  type: 'doc' as const,
  content: [
    {
      type: 'figure' as const,
      attrs: { imageId: 'img-1', alt: 'A picture', safeToShare },
      content: [{ type: 'text' as const, text: 'A caption' }],
    },
  ],
})

const readOnlyWith = (safeToShare: boolean) =>
  reportModelFor({
    permissions: [],
    contents: {
      summary: {
        values: {
          'summary-text': { type: 'rich_text', doc: figureDoc(safeToShare) },
        },
        sections: {},
      },
    },
  })

describe('images in the read-only view', () => {
  test('a figure is drawn by the image element and says it is not marked safe', () => {
    scene(
      { update, view },
      given(readOnlyWith(false)),
      openSummary,
      focused,
      expect(selector('figure[data-image-id="img-1"] quoroom-image')).toExist(),
      expect(selector('figure[data-safe="false"]')).toExist(),
      expect(
        text('Not marked safe to share. Withheld from redacted views.'),
      ).toExist(),
      expect(text('A caption')).toExist(),
      expect(selector('quoroom-editor')).toBeAbsent(),
    )
  })

  test('a figure marked safe says so', () => {
    scene(
      { update, view },
      given(readOnlyWith(true)),
      openSummary,
      focused,
      expect(selector('figure[data-safe="true"]')).toExist(),
      expect(text('Marked safe to share.')).toExist(),
    )
  })
})

describe('image limits beside the editor', () => {
  test('the limits are stated, then the server figures replace them after an upload', () => {
    scene(
      { update, view },
      given(reportModelFor()),
      openSummary,
      focused,
      editorLoaded,
      expect(text(/Each image: at most 1\.0 MB/)).toExist(),
      CustomElement.emit(editorElement, selector('quoroom-editor'), 'image', {
        imageId: 'img-1',
        size: 400_000,
      }),
      Command.resolve(
        Report.LoadImageUsage,
        Report.Message.SucceededLoadImageUsage({
          scope: SCOPE,
          usage: { usedBytes: 400_000, limitBytes: 20_000_000 },
        }),
      ),
      expect(
        text(/Images in this report: 400 KB of 20\.0 MB used, 19\.6 MB left/),
      ).toExist(),
    )
  })

  test('a failed refresh keeps the last figures and shows nothing wrong', () => {
    scene(
      { update, view },
      given(reportModelFor()),
      openSummary,
      focused,
      editorLoaded,
      CustomElement.emit(editorElement, selector('quoroom-editor'), 'image', {
        imageId: 'img-1',
        size: 400_000,
      }),
      Command.resolve(
        Report.LoadImageUsage,
        Report.Message.FailedLoadImageUsage({ scope: SCOPE }),
      ),
      expect(text(/Each image: at most 1\.0 MB/)).toExist(),
    )
  })
})
