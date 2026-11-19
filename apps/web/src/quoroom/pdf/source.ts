import { Array, Effect, Option, Record } from 'effect'

import {
  CONTENT_SCHEMA_VERSION,
  type DocumentDescription,
  DownloadVersion,
  History,
  type Person,
  type ReportContent,
  type ReportSummary,
  type RevisionOutline,
  type SectionContent,
  type Template,
  type Theme,
  approvalRecordDescription,
  approvalRecordFileName,
  documentDescription,
  pdfFileName,
} from '@quoroom/domain'

import type { QuoroomClient } from '../api'
import { topLevelSections } from '../draftText'
import { base64ToBytes, loadImage } from '../images/read'
import type { ImageContext } from '../images/spec'

// NOTE: What a PDF is made from: the same requests the reading
// screens make, never a new one. An author reads a draft or a revision
// through its draft (original or as stored for redacted roles); a reviewer
// reads the revision, in the view the server chose for the role. The content
// is the server's: a redacted view is built from content the server already
// redacted, and an image the redacted view withholds is not in the
// description, so it is never fetched.

export type Basics = Readonly<{
  reportId: string
  summary: ReportSummary
  template: Template
  theme: Theme
  history: typeof History.Type
}>

export type Built = Readonly<{
  description: DocumentDescription
  fileName: string
  context: ImageContext
  logoImageId: string | undefined
}>

export const isoDate = (at: number): string =>
  new Date(at).toISOString().slice(0, 10)

export const loadBasics = (client: QuoroomClient, reportId: string) =>
  Effect.gen(function* () {
    const detail = yield* client.GetReport({ reportId })
    const summary = detail.summary
    const record = yield* client.GetTemplateVersion({
      templateId: summary.templateId,
      version: summary.templateVersion,
      reportId,
    })
    const themeRecord = yield* client.GetTheme()
    const history = yield* client.GetHistory({ reportId })
    return {
      reportId,
      summary,
      template: record.template,
      theme: themeRecord.theme,
      history,
    } satisfies Basics
  })

const contentOf = (
  template: Template,
  sections: ReadonlyArray<readonly [string, SectionContent]>,
): ReportContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: template.id,
  templateVersion: template.version,
  sections: Record.fromEntries(sections),
})

const draftOfVersion = (
  basics: Basics,
  version: typeof DownloadVersion.Type,
) =>
  version.kind === 'draft'
    ? Option.some(version.number)
    : Option.map(
        Array.findFirst(
          basics.history.revisions,
          revision => revision.number === version.number,
        ),
        revision => revision.draft,
      )

// NOTE: The conclusion is part of the file when the report is concluding or
// archived (a revision closing the report); otherwise the description's own
// default holds: only if the conclusion has content (D23).
export const isConcluding = (state: string): boolean =>
  state === 'concluding' || state === 'archived'

export const conclusionChoice = (
  concluding: boolean,
): { includeConclusion?: boolean } =>
  concluding ? { includeConclusion: true } : {}

// NOTE: What each builder asks of the client, so a test can give it only that.
export type ClientError = Effect.Error<
  ReturnType<QuoroomClient['GetRevisionOutline']>
>
type Reply<A> = Effect.Effect<A, ClientError>
export type AuthorClient = Readonly<{
  GetPeople: (payload: {
    reportId: string
    draft: number
  }) => Reply<{ people: ReadonlyArray<Person> }>
  GetDraftSection: (payload: {
    reportId: string
    draft: number
    sectionId: string
    view: 'original' | 'redacted'
  }) => Reply<{ content: SectionContent }>
}>
export type ReviewerClient = Readonly<{
  GetRevisionOutline: (payload: {
    reportId: string
    revision: number
  }) => Reply<RevisionOutline>
  GetTemplateVersion: (payload: {
    templateId: string
    version: number
    reportId: string
    revision: number
  }) => Reply<{ template: Template }>
  GetTheme: () => Reply<{ theme: Theme }>
  GetRevisionSection: (payload: {
    reportId: string
    revision: number
    sectionId: string
  }) => Reply<{ content: SectionContent }>
}>

export const authorVersion = (
  client: AuthorClient,
  basics: Basics,
  version: typeof DownloadVersion.Type,
) =>
  Effect.gen(function* () {
    const { reportId, template, summary } = basics
    const draft = yield* Option.match(draftOfVersion(basics, version), {
      onNone: () => Effect.fail({ _tag: 'NotFound' }),
      onSome: Effect.succeed,
    })
    const { people } = yield* client.GetPeople({ reportId, draft })
    // NOTE: The server answers an empty section for a section without a row,
    // so no error is swallowed here: a real failure fails the file.
    const sections = yield* Effect.forEach(
      topLevelSections(template),
      section =>
        client
          .GetDraftSection({
            reportId,
            draft,
            sectionId: section.id,
            view: version.view,
          })
          .pipe(Effect.map(read => [section.id, read.content] as const)),
      { concurrency: 4 },
    )
    const description = documentDescription({
      template,
      content: contentOf(template, sections),
      view: { kind: version.view, people },
      caseFile: {
        reference: summary.caseFile.reference,
        unit: '',
        title: summary.caseFile.title,
      },
      theme: basics.theme,
      version: {
        reportName: summary.templateName,
        versionLabel: version.label,
        date: isoDate(version.at),
      },
      ...conclusionChoice(isConcluding(summary.state)),
    })
    return {
      description,
      fileName: pdfFileName({
        caseReference: summary.caseFile.reference,
        templateShortName: template.shortName,
        version: { kind: version.kind, number: version.number },
        redacted: version.view === 'redacted',
        people: people satisfies ReadonlyArray<Person>,
      }),
      context:
        version.kind === 'draft'
          ? { kind: 'draft', draft: version.number }
          : { kind: 'revision', revision: version.number },
      logoImageId: basics.theme.logo,
    } satisfies Built
  })

export const reviewerVersion = (
  client: ReviewerClient,
  reportId: string,
  revision: number,
) =>
  Effect.gen(function* () {
    const outline = yield* client.GetRevisionOutline({ reportId, revision })
    const record = yield* client.GetTemplateVersion({
      templateId: outline.templateId,
      version: outline.templateVersion,
      reportId,
      revision,
    })
    const themeRecord = yield* client.GetTheme()
    const template = record.template
    const sections = yield* Effect.forEach(
      outline.sections,
      ref =>
        client
          .GetRevisionSection({ reportId, revision, sectionId: ref.sectionId })
          .pipe(Effect.map(read => [ref.sectionId, read.content] as const)),
      { concurrency: 4 },
    )
    const redacted = outline.view === 'redacted'
    const description = documentDescription({
      template,
      content: contentOf(template, sections),
      // NOTE: Only labels reach a reviewer; they print where a people item
      // names someone, for a full reviewer as well (never a raw ID).
      view: {
        kind: redacted ? 'redacted' : 'original',
        people: Array.map(outline.personLabels, person => ({
          id: person.id,
          name: person.label,
          label: person.label,
          aliases: [],
        })),
      },
      caseFile: {
        reference: outline.caseReference,
        unit: '',
        title: outline.caseTitle,
      },
      theme: themeRecord.theme,
      version: {
        reportName: template.name,
        versionLabel: outline.label,
        date: isoDate(outline.publishedAt),
      },
      ...conclusionChoice(outline.closing),
    })
    return {
      description,
      fileName: pdfFileName({
        caseReference: outline.caseReference,
        templateShortName: template.shortName,
        version: { kind: 'revision', number: revision },
        redacted,
        people: [],
      }),
      context: { kind: 'revision', revision },
      logoImageId: themeRecord.theme.logo,
    } satisfies Built
  })

export const approvalRecord = (client: QuoroomClient, basics: Basics) =>
  Effect.gen(function* () {
    const data = yield* client.GetApprovalRecordData({
      reportId: basics.reportId,
    })
    const now = yield* Effect.sync(() => Date.now())
    return {
      description: approvalRecordDescription({
        template: basics.template,
        flow: data.flow,
        events: data.events,
        authors: data.authors,
        accountNames: data.accountNames,
        caseFile: data.caseFile,
        theme: basics.theme,
        reportName: data.reportName,
        date: isoDate(now),
      }),
      fileName: approvalRecordFileName({
        caseReference: data.caseFile.reference,
        templateShortName: basics.template.shortName,
      }),
      context: { kind: 'working_copy' },
      logoImageId: basics.theme.logo,
    } satisfies Built
  })

export const dataUriOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

// NOTE: The images a description names, as data URIs, read through the
// version they belong to (D5). An image that cannot be read is left out and
// the PDF prints a note in its place.
// NOTE: A cache of what was read, kept by "Download all" across the versions
// it renders (the logo and the images that did not change are read once).
export type ImageCache = Map<string, string>

export const imagesOf = (
  reportId: string,
  built: Pick<Built, 'context' | 'logoImageId'> &
    Readonly<{ description: Pick<Built['description'], 'imageIds'> }>,
  cache?: ImageCache,
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.forEach(
    built.description.imageIds,
    imageId => {
      const known = cache?.get(imageId)
      return known !== undefined
        ? Effect.succeed(Option.some([imageId, known] as const))
        : Effect.tryPromise(async signal => {
            const loaded = await loadImage(
              {
                imageId,
                reportId,
                context:
                  imageId === built.logoImageId
                    ? { kind: 'theme' }
                    : built.context,
              },
              signal,
            )
            if (Option.isNone(loaded)) return Option.none()
            const uri = await dataUriOf(loaded.value.blob)
            cache?.set(imageId, uri)
            return Option.some([imageId, uri] as const)
          }).pipe(Effect.catch(() => Effect.succeed(Option.none())))
    },
    { concurrency: 3 },
  ).pipe(Effect.map(found => new Map(Array.getSomes(found))))

export const bytesOfBase64 = base64ToBytes
