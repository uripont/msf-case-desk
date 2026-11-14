import { clsx } from 'clsx'
import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  DownloadSet,
  DownloadVersion,
  approvalRecordFileName,
} from '@case-desk/domain'

import { AppRoute, pathOf } from '../route'
import { focusRing } from '../style'
import { type QuoroomClient, withQuoroom } from './api'
import { momentText } from './draftText'
import { actionButton } from './entryViews'
import { Failure, failureOf, failureText } from './failure'
import { renderBuilt, saveFile } from './pdf/make'
import {
  type Basics,
  type Built,
  type ImageCache,
  approvalRecord,
  authorVersion,
  loadBasics,
} from './pdf/source'
import { PageScope, isCurrentPage, pageScopeOf } from './scope'
import { alertText, loadingText, statusText } from './ui'
import { LoadState } from './unit'

// NOTE: Downloads (stage 8): a PDF of any draft or revision, original or as
// stored for redacted roles, the approval record, and all of them as one zip.
// Nothing is stored: each PDF is made here, in the browser, from the content
// the server returns to this person, and handed to the browser as a file. The
// PDF library and its fonts are one lazy chunk, fetched the first time.

export const MakeTarget = defineTaggedUnion({
  One: { version: DownloadVersion },
  Approval: {},
  All: {},
})
export type MakeTarget = typeof MakeTarget.Type

export const keyOfVersion = (version: typeof DownloadVersion.Type): string =>
  `${version.kind}:${version.number}:${version.view}`

export const keyOfTarget = (target: MakeTarget): string =>
  MakeTarget.match(target, {
    One: ({ version }) => keyOfVersion(version),
    Approval: () => 'approval',
    All: () => 'all',
  })

export const Model = Schema.Struct({
  origin: Schema.String,
  reportId: Schema.String,
  generation: Schema.Int,
  load: LoadState,
  maybeDownloads: Schema.Option(DownloadSet),
  maybeBusy: Schema.Option(Schema.String),
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel = Model.make({
  origin: '',
  reportId: '',
  generation: 0,
  load: LoadState.Loading(),
  maybeDownloads: Option.none(),
  maybeBusy: Option.none(),
  maybeNotice: Option.none(),
})

export const Message = defineMessageUnion({
  SucceededLoadDownloads: { scope: PageScope, downloads: DownloadSet },
  FailedLoadDownloads: { scope: PageScope, failure: Failure },
  ClickedRetryLoad: {},
  ClickedMake: { target: MakeTarget },
  SucceededMakeFile: { scope: PageScope },
  FailedMakeFile: { scope: PageScope, failure: Failure },
})
export type Message = typeof Message.Type

export const LoadDownloads = Command.define('LoadDownloads', {
  args: { scope: PageScope },
  messages: [Message.SucceededLoadDownloads, Message.FailedLoadDownloads],
  execute: ({ scope, scope: { reportId } }) =>
    withQuoroom(client => client.GetDownloads({ reportId })).pipe(
      Effect.map(downloads =>
        Message.SucceededLoadDownloads({ scope, downloads }),
      ),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedLoadDownloads({ scope, failure: failureOf(error) }),
        ),
      ),
    ),
})

const asList = (built: Built): ReadonlyArray<Built> => [built]

const builtOf = (client: QuoroomClient, basics: Basics, target: MakeTarget) =>
  target._tag === 'One'
    ? Effect.map(authorVersion(client, basics, target.version), asList)
    : target._tag === 'Approval'
      ? Effect.map(approvalRecord(client, basics), asList)
      : Effect.succeed<ReadonlyArray<Built>>([])

const zipName = (downloads: typeof DownloadSet.Type, shortName: string) =>
  approvalRecordFileName({
    caseReference: downloads.caseReference,
    templateShortName: shortName,
  }).replace(/approval-record\.pdf$/, 'all-versions.zip')

// NOTE: The date inside a zip is the date of its newest version at midnight
// UTC, never the clock: the same report gives the same zip.
export const zipDateOf = (downloads: typeof DownloadSet.Type): Date => {
  const newest = Math.max(
    0,
    ...Array.map(downloads.versions, version => version.at),
  )
  return new Date(newest - (newest % 86_400_000))
}

const ZIP_TOO_LARGE =
  'The files are too large to put in one zip. Download them one at a time.'

// NOTE: A zip over the safe size is refused with a clear message; any other
// failure reads as before.
export const makeFailureOf = (error: unknown): Failure => {
  const cause =
    typeof error === 'object' && error !== null && 'cause' in error
      ? error.cause
      : error
  return [error, cause].some(
    item =>
      typeof item === 'object' &&
      item !== null &&
      '_tag' in item &&
      item._tag === 'ZipTooLarge',
  )
    ? Failure.Refused({ message: ZIP_TOO_LARGE })
    : failureOf(error)
}

export const MakeFile = Command.define('MakeFile', {
  args: { scope: PageScope, downloads: DownloadSet, target: MakeTarget },
  messages: [Message.SucceededMakeFile, Message.FailedMakeFile],
  execute: ({ scope, scope: { reportId }, downloads, target }) =>
    withQuoroom(client =>
      Effect.gen(function* () {
        const basics = yield* loadBasics(client, reportId)
        const everything = MakeTarget.match(target, {
          One: () => [target],
          Approval: () => [target],
          All: () => [
            ...Array.map(downloads.versions, version =>
              MakeTarget.One({ version }),
            ),
            ...(downloads.approvalRecord ? [MakeTarget.Approval()] : []),
          ],
        })
        const { zipParts, checkZipSize } = yield* Effect.tryPromise(
          () => import('@case-desk/pdf'),
        )
        // NOTE: One file at a time, so only one document is being built at
        // once; what was read is kept across the versions, and the size is
        // checked as the files come, not after all of them.
        const cache: ImageCache = new Map()
        const sizes: Array<number> = []
        const files = yield* Effect.forEach(everything, one =>
          Effect.flatMap(builtOf(client, basics, one), built =>
            Effect.forEach(built, item =>
              Effect.flatMap(renderBuilt(reportId, item, cache), made =>
                Effect.try(() => {
                  sizes.push(made.bytes.length)
                  checkZipSize(sizes)
                  return made
                }),
              ),
            ),
          ),
        ).pipe(Effect.map(Array.flatten))
        const [first] = files
        if (target._tag !== 'All' && first !== undefined) {
          yield* saveFile(first.name, [first.bytes], 'application/pdf')
          return
        }
        const parts = yield* Effect.try(() =>
          zipParts(
            Array.map(files, file => ({ name: file.name, data: file.bytes })),
            zipDateOf(downloads),
          ),
        )
        yield* saveFile(
          zipName(downloads, basics.template.shortName),
          parts,
          'application/zip',
        )
      }),
    ).pipe(
      Effect.map(() => Message.SucceededMakeFile({ scope })),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedMakeFile({ scope, failure: makeFailureOf(error) }),
        ),
      ),
    ),
})

export const enter = (
  origin: string,
  reportId: string,
  generation: number,
): Update.Return<Model, Message> => {
  const fresh = modifyFields(initialModel, {
    origin: () => origin,
    reportId: () => reportId,
    generation: () => generation,
  })
  return {
    model: fresh,
    commands: [LoadDownloads({ scope: pageScopeOf(fresh) })],
  }
}

export const cleared = (model: Model): Model =>
  modifyFields(initialModel, { generation: () => model.generation + 1 })

const updateCurrent = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    SucceededLoadDownloads: ({ downloads }) => ({
      model: modifyFields(model, {
        load: () => LoadState.Loaded(),
        maybeDownloads: () => Option.some(downloads),
      }),
    }),
    FailedLoadDownloads: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadDownloads({ scope: pageScopeOf(model) })],
    }),
    ClickedMake: ({ target }) =>
      Option.isSome(model.maybeBusy) || Option.isNone(model.maybeDownloads)
        ? { model }
        : {
            model: modifyFields(model, {
              maybeBusy: () => Option.some(keyOfTarget(target)),
              maybeNotice: () => Option.none(),
            }),
            commands: [
              MakeFile({
                scope: pageScopeOf(model),
                downloads: model.maybeDownloads.value,
                target,
              }),
            ],
          },
    SucceededMakeFile: () => ({
      model: modifyFields(model, { maybeBusy: () => Option.none() }),
    }),
    FailedMakeFile: ({ failure }) => ({
      model: modifyFields(model, {
        maybeBusy: () => Option.none(),
        maybeNotice: () => Option.some(failureText(failure)),
      }),
    }),
  })

export const update = (
  model: Model,
  message: Message,
): Update.Return<Model, Message> =>
  'scope' in message && !isCurrentPage(model, message.scope)
    ? { model }
    : updateCurrent(model, message)

// VIEW

const shell = (
  h: HtmlBuilder<Message>,
  reportId: string,
  children: ReadonlyArray<Html>,
): Html =>
  h.section(
    [
      h.AriaLabel('Downloads'),
      h.Class('flex max-w-3xl flex-col gap-6 pt-10 md:pt-14'),
    ],
    [
      h.a(
        [
          h.Href(pathOf(AppRoute.Report({ reportId }))),
          h.Class(
            clsx('self-start text-base text-msf-ink underline', focusRing),
          ),
        ],
        ['Back to the report'],
      ),
      h.h1(
        [
          h.Id('page-heading'),
          h.Class(
            'text-balance text-4xl font-black tracking-[-0.025em] text-msf-black',
          ),
        ],
        ['Downloads'],
      ),
      ...children,
    ],
  )

const groupKey = (version: typeof DownloadVersion.Type): string =>
  `${version.kind}:${version.number}`

const versionRow = (
  h: HtmlBuilder<Message>,
  group: ReadonlyArray<typeof DownloadVersion.Type>,
  busy: Option.Option<string>,
): Html => {
  const [first] = group
  return first === undefined
    ? h.empty
    : h.keyed('li')(
        groupKey(first),
        [
          h.Class('flex flex-col gap-3 py-4'),
          h.DataAttribute('download-version', groupKey(first)),
        ],
        [
          h.p(
            [h.Class('text-lg font-medium text-msf-black')],
            [`${first.label}, ${momentText(first.at)}`],
          ),
          h.div(
            [h.Class('flex flex-wrap gap-3')],
            Array.map(group, version =>
              actionButton(
                h,
                Option.isSome(busy) && busy.value === keyOfVersion(version)
                  ? 'Making the PDF.'
                  : `Download PDF, ${version.view}`,
                `Download PDF of ${version.label}, ${version.view}`,
                Message.ClickedMake({ target: MakeTarget.One({ version }) }),
                Option.isSome(busy),
              ),
            ),
          ),
        ],
      )
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  LoadState.match(model.load, {
    Loading: () => shell(h, model.reportId, [loadingText(h, 'Loading.')]),
    Failed: ({ failure }) =>
      shell(h, model.reportId, [
        alertText(h, failureText(failure)),
        actionButton(h, 'Try again', 'Try again', Message.ClickedRetryLoad()),
      ]),
    Loaded: () =>
      Option.match(model.maybeDownloads, {
        onNone: () => shell(h, model.reportId, [loadingText(h, 'Loading.')]),
        onSome: downloads => {
          const groups = Array.groupBy(downloads.versions, groupKey)
          return shell(h, model.reportId, [
            h.p(
              [h.Class('text-base text-msf-grey')],
              [
                `${downloads.reportName}, ${downloads.caseReference}. A PDF is made on this device when you ask for it, from the version as you may read it. Nothing is stored.`,
              ],
            ),
            Option.match(model.maybeBusy, {
              onNone: () => h.empty,
              onSome: () =>
                statusText(h, 'Making the file. This can take a few seconds.'),
            }),
            Option.match(model.maybeNotice, {
              onNone: () => h.empty,
              onSome: notice => alertText(h, notice),
            }),
            actionButton(
              h,
              Option.exists(model.maybeBusy, key => key === 'all')
                ? 'Making the zip.'
                : 'Download all',
              'Download all drafts, revisions and approval records as one zip',
              Message.ClickedMake({ target: MakeTarget.All() }),
              Option.isSome(model.maybeBusy),
            ),
            downloads.approvalRecord
              ? actionButton(
                  h,
                  Option.exists(model.maybeBusy, key => key === 'approval')
                    ? 'Making the PDF.'
                    : 'Download approval record',
                  'Download the approval record PDF',
                  Message.ClickedMake({ target: MakeTarget.Approval() }),
                  Option.isSome(model.maybeBusy),
                )
              : h.empty,
            h.ul(
              [
                h.AriaLabel('Versions'),
                h.Class(
                  'flex flex-col divide-y divide-msf-line border-y border-msf-line',
                ),
              ],
              Array.map(Object.values(groups), group =>
                versionRow(h, group, model.maybeBusy),
              ),
            ),
          ])
        },
      }),
  }),
)
