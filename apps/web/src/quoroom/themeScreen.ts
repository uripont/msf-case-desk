import { clsx } from 'clsx'
import { Array, Effect, Option, Schema } from 'effect'
import { Command, Submodel, Update } from 'foldkit'
import { File } from 'foldkit/file'
import { Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'

import {
  BUNDLED_FONTS,
  DEFAULT_THEME,
  ImageMime,
  PAGE_TOKENS,
  Theme,
  ThemeRecord,
  documentDescription,
  sampleDocumentInput,
} from '@quoroom/domain'

import { fieldClassName, focusRing, labelClassName } from '../style'
import { fontStackOf } from '../theme'
import { withQuoroom } from './api'
import { Failure, failureOf, failureText } from './failure'
import { FormState, formStatus, isSubmitting } from './formState'
import { prepareImage } from './images/encode'
import { newUploadId } from './images/id'
import { planChunks, refusalText } from './images/plan'
import { loadImage } from './images/read'
import { uploadImage } from './images/upload'
import { dataUriOf } from './pdf/source'
import {
  COLOUR_NAMES,
  ColourName,
  FontRole,
  PDF_TEXT_FIELDS,
  PdfTextField,
  READABLE_RATIO,
  ThemeFields,
  fieldsOf,
  fontChoice,
  isHex,
  problemText,
  problemsAt,
  problemsOfFields,
  ratioText,
  themeOfFields,
} from './themeForm'
import {
  alertText,
  loadingText,
  pageShell,
  panel,
  selectField,
  smallButton,
  statusText,
  submitButton,
  textField,
} from './ui'
import { LoadState } from './unit'

// NOTE: The theme screen, for the `theme` capability (D24): the
// organisation's name, the logo, the colours with the contrast check shown
// beside each colour, the fonts from the bundled set, the PDF header and
// footer text, a live preview of an app page and of a PDF page, and saving.
// The domain decides what is unreadable (`validateTheme`); this screen
// places each problem beside its field. Saving never reloads the page: the
// parent applies the saved theme (OutMessage), and the next PDF reads it
// with `GetTheme`. The logo is an image owned by the theme; it is prepared
// in the browser and sent in chunks like a report's pictures, and
// it is readable by signed-in accounts only (decisions.md).

// MODEL

export const LogoPreview = Schema.Struct({
  imageId: Schema.String,
  src: Schema.String,
  mime: ImageMime,
  chunks: Schema.Int,
})
export type LogoPreview = typeof LogoPreview.Type

// NOTE: What the app needs to know of the logo, whether or not its preview
// was shown: the image, its type and how many chunks it has.
export const LogoRef = Schema.Struct({
  imageId: Schema.String,
  mime: ImageMime,
  chunks: Schema.Int,
})
export type LogoRef = typeof LogoRef.Type

export const LogoState = defineTaggedUnion({
  Idle: {},
  Sending: {},
  Failed: { message: Schema.String },
})
export type LogoState = typeof LogoState.Type

export const PdfPreview = defineTaggedUnion({
  Hidden: {},
  Rendering: { maybeSrc: Schema.Option(Schema.String) },
  Blocked: { maybeSrc: Schema.Option(Schema.String) },
  Shown: { src: Schema.String },
  Failed: { maybeSrc: Schema.Option(Schema.String) },
})
export type PdfPreview = typeof PdfPreview.Type

export const Model = Schema.Struct({
  load: LoadState,
  fields: ThemeFields,
  logoState: LogoState,
  maybeLogoPreview: Schema.Option(LogoPreview),
  // NOTE: The logo as the app has to know it, from the upload or from the
  // loaded preview; it does not depend on the preview being shown.
  maybeLogoRef: Schema.Option(LogoRef),
  // NOTE: The preview address the app now holds (handed over when the theme
  // was saved). The screen never revokes it while the app uses it, and
  // revokes it when a later save replaces it.
  maybeAppSrc: Schema.Option(Schema.String),
  pdf: PdfPreview,
  pdfGeneration: Schema.Int,
  saveForm: FormState,
  maybeNotice: Schema.Option(Schema.String),
})
export type Model = typeof Model.Type

const startFields = fieldsOf(DEFAULT_THEME)

export const initialModel = Model.make({
  load: LoadState.Loading(),
  fields: startFields,
  logoState: LogoState.Idle(),
  maybeLogoPreview: Option.none(),
  maybeLogoRef: Option.none(),
  maybeAppSrc: Option.none(),
  pdf: PdfPreview.Hidden(),
  pdfGeneration: 0,
  saveForm: FormState.Editing(),
  maybeNotice: Option.none(),
})

// MESSAGE

export const Message = defineMessageUnion({
  SucceededLoadTheme: { record: ThemeRecord },
  FailedLoadTheme: { failure: Failure },
  ClickedRetryLoad: {},
  UpdatedOrganisationName: { value: Schema.String },
  UpdatedColour: { name: ColourName, value: Schema.String },
  SelectedFont: { role: FontRole, value: Schema.String },
  UpdatedPdfText: { field: PdfTextField, value: Schema.String },
  SelectedLogoFile: { files: Schema.Array(File) },
  SucceededUploadLogo: {
    imageId: Schema.String,
    mime: ImageMime,
    chunks: Schema.Int,
  },
  FailedUploadLogo: { message: Schema.String },
  ClickedRemoveLogo: {},
  SucceededLoadLogoPreview: { preview: LogoPreview },
  FailedLoadLogoPreview: { imageId: Schema.String },
  ClickedShowPdfPreview: {},
  ClickedHidePdfPreview: {},
  SucceededRenderSamplePdf: { generation: Schema.Int, src: Schema.String },
  FailedRenderSamplePdf: { generation: Schema.Int },
  CompletedRevokeObjectUrl: {},
  SubmittedTheme: {},
  SucceededSaveTheme: { record: ThemeRecord },
  FailedSaveTheme: { failure: Failure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
  SavedTheme: {
    theme: Theme,
    maybeLogo: Schema.Option(LogoRef),
    maybeSrc: Schema.Option(Schema.String),
  },
})
export type OutMessage = typeof OutMessage.Type

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

// COMMAND

export const LoadTheme = Command.define('LoadTheme', {
  messages: [Message.SucceededLoadTheme, Message.FailedLoadTheme],
  execute: withQuoroom(client => client.GetTheme()).pipe(
    Effect.map(record => Message.SucceededLoadTheme({ record })),
    Effect.catch(error =>
      Effect.succeed(Message.FailedLoadTheme({ failure: failureOf(error) })),
    ),
  ),
})

export const SaveTheme = Command.define('SaveTheme', {
  args: { theme: Theme },
  messages: [Message.SucceededSaveTheme, Message.FailedSaveTheme],
  execute: ({ theme }) =>
    withQuoroom(client => client.UpdateTheme({ theme })).pipe(
      Effect.map(record => Message.SucceededSaveTheme({ record })),
      Effect.catch(error =>
        Effect.succeed(Message.FailedSaveTheme({ failure: failureOf(error) })),
      ),
    ),
})

const uploadLogo = async (
  file: globalThis.File,
): Promise<
  Readonly<{ imageId: string; mime: typeof ImageMime.Type; chunks: number }>
> => {
  const prepared = await prepareImage(file)
  if (!prepared.ok) {
    throw new Error(refusalText(prepared.refusal))
  }
  const uploadId = await newUploadId()
  const sent = await uploadImage({
    reportId: 'theme',
    uploadId,
    image: prepared.image,
    startAt: 0,
    onProgress: () => undefined,
  })
  if (!sent.ok) {
    throw new Error(sent.message)
  }
  return {
    imageId: uploadId,
    mime: prepared.image.mime,
    chunks: planChunks(prepared.image.bytes.length).length,
  }
}

export const UploadLogo = Command.define('UploadLogo', {
  args: { file: File },
  messages: [Message.SucceededUploadLogo, Message.FailedUploadLogo],
  execute: ({ file }) =>
    Effect.tryPromise(() => uploadLogo(file)).pipe(
      Effect.map(sent => Message.SucceededUploadLogo(sent)),
      Effect.catch(error =>
        Effect.succeed(
          Message.FailedUploadLogo({
            message:
              error.cause instanceof Error
                ? error.cause.message
                : 'The logo could not be sent.',
          }),
        ),
      ),
    ),
})

export const LoadLogoPreview = Command.define('LoadLogoPreview', {
  args: { imageId: Schema.String },
  messages: [Message.SucceededLoadLogoPreview, Message.FailedLoadLogoPreview],
  execute: ({ imageId }) =>
    Effect.tryPromise(async signal => {
      const loaded = await loadImage(
        { imageId, reportId: '', context: { kind: 'theme' } },
        signal,
      )
      if (Option.isNone(loaded)) {
        throw new Error('no logo')
      }
      return LogoPreview.make({
        imageId,
        src: URL.createObjectURL(loaded.value.blob),
        mime: loaded.value.mime,
        chunks: loaded.value.chunks,
      })
    }).pipe(
      Effect.map(preview => Message.SucceededLoadLogoPreview({ preview })),
      Effect.catch(() =>
        Effect.succeed(Message.FailedLoadLogoPreview({ imageId })),
      ),
    ),
})

const DEBOUNCE_MILLIS = 400

// NOTE: The sample document is made with the theme as it is typed, after a
// short wait so a burst of typing makes one PDF. The PDF library is loaded
// the first time this runs. Nothing is stored.
export const RenderSamplePdf = Command.define('RenderSamplePdf', {
  args: {
    theme: Theme,
    maybeLogoSrc: Schema.Option(Schema.String),
    generation: Schema.Int,
  },
  messages: [Message.SucceededRenderSamplePdf, Message.FailedRenderSamplePdf],
  execute: ({ theme, maybeLogoSrc, generation }) =>
    Effect.gen(function* () {
      yield* Effect.sleep(DEBOUNCE_MILLIS)
      const logoUri = yield* Option.match(maybeLogoSrc, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: src =>
          Effect.tryPromise(async () =>
            Option.some(await dataUriOf(await (await fetch(src)).blob())),
          ),
      })
      const images = new Map<string, string>(
        Option.match(
          Option.all({ id: Option.fromNullishOr(theme.logo), uri: logoUri }),
          {
            onNone: () => [],
            onSome: ({ id, uri }) => [[id, uri] as const],
          },
        ),
      )
      const { renderDocument } = yield* Effect.tryPromise(
        () => import('./pdf/render'),
      )
      const bytes = yield* Effect.tryPromise(() =>
        renderDocument(documentDescription(sampleDocumentInput(theme)), images),
      )
      const src = URL.createObjectURL(
        new Blob([Uint8Array.from(bytes)], { type: 'application/pdf' }),
      )
      return Message.SucceededRenderSamplePdf({ generation, src })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.FailedRenderSamplePdf({ generation })),
      ),
    ),
})

export const RevokeObjectUrl = Command.define('RevokeObjectUrl', {
  args: { src: Schema.String },
  messages: [Message.CompletedRevokeObjectUrl],
  execute: ({ src }) =>
    Effect.sync(() => URL.revokeObjectURL(src)).pipe(
      Effect.as(Message.CompletedRevokeObjectUrl()),
    ),
})

// UPDATE

export const loadedTheme = (record: ThemeRecord): Message =>
  Message.SucceededLoadTheme({ record })

export const enter = (model: Model): Update.Return<Model, Message> => ({
  model: modifyFields(model, {
    load: () => LoadState.Loading(),
    logoState: () => LogoState.Idle(),
    pdf: () => PdfPreview.Hidden(),
    saveForm: () => FormState.Editing(),
    maybeNotice: () => Option.none(),
    maybeLogoPreview: () => Option.none(),
    maybeLogoRef: () => Option.none(),
  }),
  commands: [
    LoadTheme(),
    ...revokeAll(pdfSrcOf(model.pdf)),
    ...revokePreview(model),
  ],
})

// NOTE: A logo preview's address is released when it is replaced, removed,
// loaded again or the screen is entered again, unless the app holds it.
const revokeSrc = (model: Model, src: string) =>
  Option.exists(model.maybeAppSrc, kept => kept === src)
    ? []
    : [RevokeObjectUrl({ src })]

const revokePreview = (model: Model) =>
  Option.match(model.maybeLogoPreview, {
    onNone: () => [],
    onSome: ({ src }) => revokeSrc(model, src),
  })

const revokeAll = (maybeSrc: Option.Option<string>) =>
  Option.match(maybeSrc, {
    onNone: () => [],
    onSome: src => [RevokeObjectUrl({ src })],
  })

const pdfSrcOf = (pdf: PdfPreview): Option.Option<string> =>
  PdfPreview.match(pdf, {
    Hidden: () => Option.none(),
    Rendering: ({ maybeSrc }) => maybeSrc,
    Blocked: ({ maybeSrc }) => maybeSrc,
    Shown: ({ src }) => Option.some(src),
    Failed: ({ maybeSrc }) => maybeSrc,
  })

// NOTE: the sample PDF is made again when the preview is open: with the
// theme as typed if it is valid, else the preview waits for a valid theme.
// A result is used only if it is for the latest request.
const refreshPdf = (model: Model): Return => {
  if (PdfPreview.guards.Hidden(model.pdf)) {
    return { model }
  }
  const maybeSrc = pdfSrcOf(model.pdf)
  return Option.match(themeOfFields(model.fields), {
    onNone: () => ({
      model: modifyFields(model, {
        pdf: () => PdfPreview.Blocked({ maybeSrc }),
      }),
    }),
    onSome: theme => {
      const generation = model.pdfGeneration + 1
      return {
        model: modifyFields(model, {
          pdfGeneration: () => generation,
          pdf: () => PdfPreview.Rendering({ maybeSrc }),
        }),
        commands: [
          RenderSamplePdf({
            theme,
            maybeLogoSrc: Option.map(model.maybeLogoPreview, ({ src }) => src),
            generation,
          }),
        ],
      }
    },
  })
}

const edited = (model: Model): Return =>
  refreshPdf(
    modifyFields(model, {
      saveForm: () => FormState.Editing(),
      maybeNotice: () => Option.none(),
    }),
  )

const withFields = (
  model: Model,
  change: (fields: ThemeFields) => ThemeFields,
): Return => edited(modifyFields(model, { fields: change }))

const COLOUR_SETTERS: Readonly<
  Record<ColourName, (fields: ThemeFields, value: string) => ThemeFields>
> = {
  primary: (fields, value) => modifyFields(fields, { primary: () => value }),
  accent: (fields, value) => modifyFields(fields, { accent: () => value }),
  text: (fields, value) => modifyFields(fields, { text: () => value }),
  background: (fields, value) =>
    modifyFields(fields, { background: () => value }),
}

const PDF_SETTERS: Readonly<
  Record<PdfTextField, (fields: ThemeFields, value: string) => ThemeFields>
> = {
  header: (fields, value) => modifyFields(fields, { header: () => value }),
  footer: (fields, value) => modifyFields(fields, { footer: () => value }),
  coverHeader: (fields, value) =>
    modifyFields(fields, { coverHeader: () => value }),
  coverFooter: (fields, value) =>
    modifyFields(fields, { coverFooter: () => value }),
}

const loadLogo = (fields: ThemeFields) =>
  Option.match(fields.maybeLogoId, {
    onNone: () => [],
    onSome: imageId => [LoadLogoPreview({ imageId })],
  })

const fileCount = (problems: number): string =>
  problems === 1 ? '1 problem' : `${problems} problems`

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    SucceededLoadTheme: ({ record }) => {
      const fields = fieldsOf(record.theme)
      return {
        model: modifyFields(model, {
          load: () => LoadState.Loaded(),
          fields: () => fields,
          maybeLogoPreview: () => Option.none(),
          maybeLogoRef: () => Option.none(),
        }),
        commands: [...revokePreview(model), ...loadLogo(fields)],
      }
    },
    FailedLoadTheme: ({ failure }) => ({
      model: modifyFields(model, { load: () => LoadState.Failed({ failure }) }),
    }),
    ClickedRetryLoad: () => ({
      model: modifyFields(model, { load: () => LoadState.Loading() }),
      commands: [LoadTheme()],
    }),
    UpdatedOrganisationName: ({ value }) =>
      withFields(model, fields =>
        modifyFields(fields, { organisationName: () => value }),
      ),
    UpdatedColour: ({ name, value }) =>
      withFields(model, fields => COLOUR_SETTERS[name](fields, value)),
    SelectedFont: ({ role, value }) =>
      Option.match(Option.fromNullishOr(fontChoice(value)), {
        onNone: () => ({ model }),
        onSome: font =>
          withFields(model, fields =>
            role === 'heading'
              ? modifyFields(fields, { headingFont: () => font })
              : modifyFields(fields, { bodyFont: () => font }),
          ),
      }),
    UpdatedPdfText: ({ field, value }) =>
      withFields(model, fields => PDF_SETTERS[field](fields, value)),
    SelectedLogoFile: ({ files }) =>
      Option.match(Array.head(files), {
        onNone: () => ({ model }),
        onSome: file => ({
          model: modifyFields(model, {
            logoState: () => LogoState.Sending(),
            saveForm: () => FormState.Editing(),
            maybeNotice: () => Option.none(),
          }),
          commands: [UploadLogo({ file })],
        }),
      }),
    SucceededUploadLogo: ({ imageId, mime, chunks }) => ({
      model: modifyFields(model, {
        logoState: () => LogoState.Idle(),
        fields: fields =>
          modifyFields(fields, { maybeLogoId: () => Option.some(imageId) }),
        maybeLogoPreview: () => Option.none(),
        maybeLogoRef: () => Option.some({ imageId, mime, chunks }),
      }),
      commands: [...revokePreview(model), LoadLogoPreview({ imageId })],
    }),
    FailedUploadLogo: ({ message }) => ({
      model: modifyFields(model, {
        logoState: () => LogoState.Failed({ message }),
      }),
    }),
    ClickedRemoveLogo: () => {
      const next = withFields(
        modifyFields(model, {
          maybeLogoPreview: () => Option.none(),
          maybeLogoRef: () => Option.none(),
          logoState: () => LogoState.Idle(),
        }),
        fields => modifyFields(fields, { maybeLogoId: () => Option.none() }),
      )
      return {
        ...next,
        commands: [...(next.commands ?? []), ...revokePreview(model)],
      }
    },
    SucceededLoadLogoPreview: ({ preview }) =>
      Option.exists(model.fields.maybeLogoId, id => id === preview.imageId)
        ? (() => {
            const next = refreshPdf(
              modifyFields(model, {
                maybeLogoPreview: () => Option.some(preview),
                maybeLogoRef: () =>
                  Option.some({
                    imageId: preview.imageId,
                    mime: preview.mime,
                    chunks: preview.chunks,
                  }),
              }),
            )
            return {
              ...next,
              commands: [
                ...(next.commands ?? []),
                ...(Option.exists(
                  model.maybeLogoPreview,
                  old => old.src === preview.src,
                )
                  ? []
                  : revokePreview(model)),
              ],
            }
          })()
        : { model, commands: [RevokeObjectUrl({ src: preview.src })] },
    FailedLoadLogoPreview: ({ imageId }) =>
      Option.exists(model.fields.maybeLogoId, id => id === imageId)
        ? {
            model: modifyFields(model, {
              logoState: () =>
                LogoState.Failed({ message: 'The logo could not be shown.' }),
            }),
          }
        : { model },
    ClickedShowPdfPreview: () =>
      refreshPdf(
        modifyFields(model, {
          pdf: () => PdfPreview.Rendering({ maybeSrc: Option.none() }),
        }),
      ),
    ClickedHidePdfPreview: () => ({
      model: modifyFields(model, {
        pdf: () => PdfPreview.Hidden(),
        pdfGeneration: generation => generation + 1,
      }),
      commands: revokeAll(pdfSrcOf(model.pdf)),
    }),
    SucceededRenderSamplePdf: ({ generation, src }) =>
      generation === model.pdfGeneration && !PdfPreview.guards.Hidden(model.pdf)
        ? {
            model: modifyFields(model, {
              pdf: () => PdfPreview.Shown({ src }),
            }),
            commands: revokeAll(pdfSrcOf(model.pdf)),
          }
        : { model, commands: [RevokeObjectUrl({ src })] },
    FailedRenderSamplePdf: ({ generation }) =>
      generation === model.pdfGeneration && !PdfPreview.guards.Hidden(model.pdf)
        ? {
            model: modifyFields(model, {
              pdf: () => PdfPreview.Failed({ maybeSrc: pdfSrcOf(model.pdf) }),
            }),
          }
        : { model },
    CompletedRevokeObjectUrl: () => ({ model }),
    SubmittedTheme: () =>
      isSubmitting(model.saveForm) || LogoState.guards.Sending(model.logoState)
        ? { model }
        : Option.match(themeOfFields(model.fields), {
            onNone: () => ({
              model: modifyFields(model, {
                maybeNotice: () => Option.none(),
                saveForm: () =>
                  FormState.Invalid({
                    message: `The theme was not saved: ${fileCount(problemsOfFields(model.fields).length)} to fix first, shown beside the fields.`,
                  }),
              }),
            }),
            onSome: theme => ({
              model: modifyFields(model, {
                maybeNotice: () => Option.none(),
                saveForm: () => FormState.Submitting(),
              }),
              commands: [SaveTheme({ theme })],
            }),
          }),
    SucceededSaveTheme: ({ record }) => {
      const isSaved = (imageId: string) =>
        Option.exists(
          Option.fromNullishOr(record.theme.logo),
          id => id === imageId,
        )
      // NOTE: The logo reference goes to the app whether or not the preview
      // had been shown; the address only when it has.
      const maybeSrc = Option.map(
        Option.filter(model.maybeLogoPreview, ({ imageId }) =>
          isSaved(imageId),
        ),
        ({ src }) => src,
      )
      return {
        model: modifyFields(model, {
          fields: () => fieldsOf(record.theme),
          saveForm: () => FormState.Editing(),
          maybeNotice: () =>
            Option.some('The theme is saved. The app and the next PDF use it.'),
          maybeAppSrc: () => maybeSrc,
        }),
        commands: Option.match(model.maybeAppSrc, {
          onNone: () => [],
          onSome: old =>
            Option.exists(maybeSrc, next => next === old)
              ? []
              : [RevokeObjectUrl({ src: old })],
        }),
        outMessage: OutMessage.SavedTheme({
          theme: record.theme,
          maybeLogo: Option.filter(model.maybeLogoRef, ({ imageId }) =>
            isSaved(imageId),
          ),
          maybeSrc,
        }),
      }
    },
    FailedSaveTheme: ({ failure }) => ({
      model: modifyFields(model, {
        saveForm: () => FormState.Failed({ failure }),
      }),
    }),
  })

// VIEW

type Problems = ReturnType<typeof problemsOfFields>

const problemLines = (
  h: HtmlBuilder<Message>,
  problems: Problems,
  key: string,
): ReadonlyArray<Html> =>
  Array.map(problemsAt(problems, key), problem =>
    h.p(
      [
        h.Role('alert'),
        h.DataAttribute('theme-problem', key),
        h.Class('text-base font-medium text-brand-alert'),
      ],
      [problemText(problem)],
    ),
  )

const colourLabels: Readonly<Record<ColourName, string>> = {
  primary: 'Primary colour',
  accent: 'Accent colour',
  text: 'Text colour',
  background: 'Background colour',
}

const colourHints: Readonly<Record<ColourName, string>> = {
  primary: 'Headings, links and buttons. Read against the background.',
  accent: 'Highlights. Read against the background.',
  text: 'Body text, read against the background.',
  background: 'The page behind the text.',
}

const colourField = (
  h: HtmlBuilder<Message>,
  model: Model,
  problems: Problems,
  name: ColourName,
): Html => {
  const value = model.fields[name]
  const id = `theme-${name}`
  const ratio =
    name === 'background'
      ? Option.none<string>()
      : ratioText(value, model.fields.background)
  return h.div(
    [h.Class('flex flex-col gap-2'), h.DataAttribute('theme-colour', name)],
    [
      h.label([h.Class(labelClassName), h.For(id)], [colourLabels[name]]),
      h.p([h.Class('-mt-1 text-sm text-brand-grey')], [colourHints[name]]),
      h.div(
        [h.Class('flex items-center gap-3')],
        [
          h.input([
            h.Id(id),
            h.Type('text'),
            h.Value(value),
            h.Autocomplete('off'),
            h.AriaInvalid(problemsAt(problems, `colors.${name}`).length > 0),
            h.Class(clsx(fieldClassName, 'max-w-44 font-mono')),
            h.OnInput(next => Message.UpdatedColour({ name, value: next })),
          ]),
          h.input([
            h.Type('color'),
            h.Value(isHex(value) ? value.trim().toLowerCase() : '#000000'),
            h.AriaLabel(`Pick the ${colourLabels[name].toLowerCase()}`),
            h.Class(
              'h-12 w-14 cursor-pointer border border-brand-line bg-white p-1',
            ),
            h.OnInput(next => Message.UpdatedColour({ name, value: next })),
          ]),
        ],
      ),
      Option.match(ratio, {
        onNone: () => h.empty,
        onSome: text =>
          h.p(
            [
              h.DataAttribute('theme-ratio', name),
              h.Class('text-sm text-brand-grey'),
            ],
            [
              `Contrast with the background: ${text} (at least ${READABLE_RATIO}:1 is needed).`,
            ],
          ),
      }),
      ...problemLines(h, problems, `colors.${name}`),
    ],
  )
}

const fontChoices = Array.map(BUNDLED_FONTS, font => ({
  value: font,
  label: font,
}))

const pdfLabels: Readonly<Record<PdfTextField, string>> = {
  header: 'Header text',
  footer: 'Footer text',
  coverHeader: 'Cover page header text',
  coverFooter: 'Cover page footer text',
}

const logoPanel = (h: HtmlBuilder<Message>, model: Model): Html =>
  panel(
    h,
    'Logo',
    [
      Option.match(model.maybeLogoPreview, {
        onNone: () =>
          Option.isSome(model.fields.maybeLogoId)
            ? loadingText(h, 'Loading the logo.')
            : h.p([h.Class('text-base text-brand-grey')], ['No logo is set.']),
        onSome: preview =>
          h.img([
            h.Src(preview.src),
            h.Alt('The logo as uploaded'),
            h.DataAttribute('theme-logo', preview.imageId),
            h.Class('block h-16 w-auto self-start border border-brand-line p-2'),
          ]),
      }),
      h.div(
        [h.Class('flex flex-col gap-2')],
        [
          h.label(
            [h.Class(labelClassName), h.For('theme-logo-file')],
            ['Choose a logo'],
          ),
          h.input([
            h.Id('theme-logo-file'),
            h.Type('file'),
            h.Accept('image/*'),
            h.Class('text-base text-brand-ink'),
            h.OnFileChange(files => Message.SelectedLogoFile({ files })),
          ]),
        ],
      ),
      LogoState.match(model.logoState, {
        Idle: () => h.empty,
        Sending: () => statusText(h, 'Preparing and sending the logo.'),
        Failed: ({ message }) => alertText(h, message),
      }),
      Option.isSome(model.fields.maybeLogoId)
        ? smallButton(h, 'Remove the logo', Message.ClickedRemoveLogo())
        : h.empty,
    ],
    Option.some(
      'The picture is made smaller and its hidden information is removed here, in the browser, before it is sent. It is shown to signed-in people only. A new logo is used once the theme is saved.',
    ),
  )

const previewStyle = (fields: ThemeFields): Record<string, string> => {
  const pick = (value: string, fallback: string): string =>
    isHex(value) ? value.trim().toLowerCase() : fallback
  return {
    '--color-brand-primary': pick(fields.primary, DEFAULT_THEME.colors.primary),
    '--color-brand-accent': pick(fields.accent, DEFAULT_THEME.colors.accent),
    '--color-brand-ink': pick(fields.text, DEFAULT_THEME.colors.text),
    '--color-brand-paper': pick(
      fields.background,
      DEFAULT_THEME.colors.background,
    ),
    '--font-sans': fontStackOf(fields.bodyFont),
    '--font-heading': fontStackOf(fields.headingFont),
  }
}

const appPreview = (h: HtmlBuilder<Message>, model: Model): Html => {
  const name = model.fields.organisationName.trim()
  return h.div(
    [
      h.Role('region'),
      h.AriaLabel('Preview of an app page'),
      h.Style({
        ...previewStyle(model.fields),
        backgroundColor: 'var(--color-brand-paper)',
        color: 'var(--color-brand-ink)',
        fontFamily: 'var(--font-sans)',
      }),
      h.Class('flex flex-col gap-4 border border-brand-line p-5'),
    ],
    [
      h.div(
        [h.Class('flex items-center gap-4')],
        [
          Option.match(model.maybeLogoPreview, {
            onNone: () => h.empty,
            onSome: preview =>
              h.img([
                h.Src(preview.src),
                h.Alt(''),
                h.Class('block h-10 w-auto'),
              ]),
          }),
          h.p(
            [
              h.Class(
                'flex flex-wrap items-baseline gap-x-3 text-xl font-black',
              ),
            ],
            [
              'Quoroom',
              h.span(
                [
                  h.DataAttribute('preview-name', 'true'),
                  h.Class('text-base font-normal'),
                ],
                [name === '' ? 'Your organisation' : name],
              ),
            ],
          ),
        ],
      ),
      h.h3(
        [
          h.Style({ color: 'var(--color-brand-primary)' }),
          h.Class('text-2xl font-black'),
        ],
        ['A heading in the heading font'],
      ),
      h.p(
        [h.Class('text-base')],
        [
          'Body text is set in the body font and the text colour, on the background colour. ',
          h.span(
            [
              h.Style({ color: 'var(--color-brand-accent)' }),
              h.Class('font-medium'),
            ],
            ['A highlight in the accent colour.'],
          ),
        ],
      ),
      h.span(
        [
          h.Style({
            backgroundColor: 'var(--color-brand-primary)',
            color: 'var(--color-brand-paper)',
          }),
          h.Class(
            'inline-flex h-10 items-center self-start px-4 text-base font-medium',
          ),
        ],
        ['A button'],
      ),
    ],
  )
}

const pdfPreview = (h: HtmlBuilder<Message>, model: Model): Html => {
  const frame = (src: string): Html =>
    h.iframe([
      h.Src(src),
      h.Title('Sample PDF'),
      h.DataAttribute('sample-pdf', 'true'),
      h.Class('h-[34rem] w-full border border-brand-line bg-white'),
    ])
  const shown = (maybeSrc: Option.Option<string>): ReadonlyArray<Html> =>
    Option.match(maybeSrc, { onNone: () => [], onSome: src => [frame(src)] })
  return h.div(
    [
      h.Role('region'),
      h.AriaLabel('Preview of a PDF'),
      h.Class('flex flex-col gap-3'),
    ],
    PdfPreview.match<ReadonlyArray<Html>>(model.pdf, {
      Hidden: () => [
        h.p(
          [h.Class('text-base text-brand-grey')],
          [
            'A sample document, with a cover page and a page of text, is made with the theme as typed. The PDF tools are loaded only when you ask for it.',
          ],
        ),
        smallButton(h, 'Show a sample PDF', Message.ClickedShowPdfPreview()),
      ],
      Rendering: ({ maybeSrc }) => [
        statusText(h, 'Making the sample PDF.'),
        ...shown(maybeSrc),
        smallButton(h, 'Hide the sample PDF', Message.ClickedHidePdfPreview()),
      ],
      Blocked: ({ maybeSrc }) => [
        statusText(
          h,
          'The sample PDF is made again when the problems shown above are fixed.',
        ),
        ...shown(maybeSrc),
        smallButton(h, 'Hide the sample PDF', Message.ClickedHidePdfPreview()),
      ],
      Shown: ({ src }) => [
        frame(src),
        h.a(
          [
            h.Href(src),
            h.Download('quoroom-sample.pdf'),
            h.Class(
              clsx('self-start text-base text-brand-ink underline', focusRing),
            ),
          ],
          ['Download the sample PDF'],
        ),
        smallButton(h, 'Hide the sample PDF', Message.ClickedHidePdfPreview()),
      ],
      Failed: ({ maybeSrc }) => [
        alertText(h, 'The sample PDF could not be made. Try again.'),
        ...shown(maybeSrc),
        smallButton(h, 'Try again', Message.ClickedShowPdfPreview()),
      ],
    }),
  )
}

const loaded = (h: HtmlBuilder<Message>, model: Model): ReadonlyArray<Html> => {
  const problems = problemsOfFields(model.fields)
  const unreadable = Array.some(
    problems,
    problem => problem.code === 'low-contrast',
  )
  return [
    h.form(
      [
        h.AriaLabel('Theme'),
        h.Class('flex flex-col gap-10'),
        h.OnSubmit(Message.SubmittedTheme()),
      ],
      [
        panel(h, 'Organisation', [
          h.div(
            [h.Class('flex max-w-xl flex-col gap-2')],
            [
              textField(h, {
                id: 'theme-name',
                label: 'Organisation name',
                value: model.fields.organisationName,
                onInput: value => Message.UpdatedOrganisationName({ value }),
              }),
              ...problemLines(h, problems, 'organisationName'),
            ],
          ),
        ]),
        logoPanel(h, model),
        panel(
          h,
          'Colours',
          [
            h.div(
              [h.Class('grid gap-6 md:grid-cols-2')],
              Array.map(COLOUR_NAMES, name =>
                colourField(h, model, problems, name),
              ),
            ),
            unreadable
              ? h.p(
                  [
                    h.Role('alert'),
                    h.Class('text-base font-medium text-brand-alert'),
                  ],
                  [
                    'Some text would be hard to read. A theme like this cannot be saved.',
                  ],
                )
              : h.empty,
          ],
          Option.some(
            `Text must be readable: at least ${READABLE_RATIO}:1 against the background (WCAG AA).`,
          ),
        ),
        panel(h, 'Fonts', [
          h.div(
            [h.Class('grid max-w-xl gap-4')],
            [
              selectField(
                h,
                'theme-heading-font',
                'Heading font',
                model.fields.headingFont,
                fontChoices,
                value => Message.SelectedFont({ role: 'heading', value }),
              ),
              selectField(
                h,
                'theme-body-font',
                'Body font',
                model.fields.bodyFont,
                fontChoices,
                value => Message.SelectedFont({ role: 'body', value }),
              ),
            ],
          ),
        ]),
        panel(
          h,
          'PDF header and footer',
          [
            h.div(
              [h.Class('flex max-w-xl flex-col gap-4')],
              Array.map(PDF_TEXT_FIELDS, field =>
                h.div(
                  [h.Class('flex flex-col gap-2')],
                  [
                    textField(h, {
                      id: `theme-${field}`,
                      label: pdfLabels[field],
                      value: model.fields[field],
                      onInput: value =>
                        Message.UpdatedPdfText({ field, value }),
                    }),
                    ...problemLines(h, problems, `pdf.${field}`),
                  ],
                ),
              ),
            ),
          ],
          Option.some(
            `Leave a text empty to print none. Tokens: ${PAGE_TOKENS.join(', ')} (the page number, the number of pages, the case reference and the report title). A template's own header and footer replace these.`,
          ),
        ),
        panel(h, 'Preview', [
          h.h3([h.Class('text-xl font-bold')], ['An app page']),
          appPreview(h, model),
          h.h3([h.Class('text-xl font-bold')], ['A PDF']),
          pdfPreview(h, model),
        ]),
        h.div(
          [h.Class('flex flex-col gap-3')],
          [
            submitButton(
              h,
              'Save the theme',
              isSubmitting(model.saveForm),
              'Saving.',
            ),
            formStatus(h, model.saveForm, 'Saving.'),
            Option.match(model.maybeNotice, {
              onNone: () => h.empty,
              onSome: notice => statusText(h, notice),
            }),
          ],
        ),
      ],
    ),
  ]
}

export const view = Submodel.defineView<Model, Message>((model, h) =>
  pageShell(
    h,
    'Theme',
    'Theme',
    'The name, logo, colours, fonts and PDF header and footer of this deployment. The app and every PDF made after saving use them.',
    LoadState.match(model.load, {
      Loading: () => [loadingText(h, 'Loading.')],
      Failed: ({ failure }) => [
        alertText(h, failureText(failure)),
        smallButton(h, 'Try again', Message.ClickedRetryLoad()),
      ],
      Loaded: () => loaded(h, model),
    }),
  ),
)
