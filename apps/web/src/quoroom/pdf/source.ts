import { Array, Effect, Option, Record } from 'effect'

import {
  CONTENT_SCHEMA_VERSION,
  type DocumentDescription,
  DownloadVersion,
  History,
  type Person,
  type ReportContent,
  type ReportSummary,
  type SectionContent,
  type Template,
  type Theme,
  approvalRecordDescription,
  approvalRecordFileName,
  documentDescription,
  pdfFileName,
} from '@case-desk/domain'

import type { QuoroomClient } from '../api'
import { topLevelSections } from '../draftText'
import { base64ToBytes, loadImage } from '../images/read'
import type { ImageContext } from '../images/spec'

// NOTE: What a PDF is made from (stage 8): the same requests the reading
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

export const authorVersion = (
  client: QuoroomClient,
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
    const found = yield* Effect.forEach(
      topLevelSections(template),
      section =>
        client
          .GetDraftSection({
            reportId,
            draft,
            sectionId: section.id,
            view: version.view,
          })
          .pipe(
            Effect.map(read =>
              Option.some([section.id, read.content] as const),
            ),
            Effect.catch(error =>
              template.conclusion?.id === section.id
                ? Effect.succeed(Option.none())
                : Effect.fail(error),
            ),
          ),
      { concurrency: 4 },
    )
    const sections = Array.getSomes(found)
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
      includeConclusion:
        template.conclusion !== undefined &&
        sections.some(([id]) => id === template.conclusion?.id),
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
    } satisfies Built
  })

export const reviewerVersion = (
  client: QuoroomClient,
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
      view: { kind: redacted ? 'redacted' : 'original', people: [] },
      caseFile: {
        reference: outline.caseReference,
        unit: '',
        title: outline.caseTitle,
      },
      theme: themeRecord.theme,
      version: {
        reportName: template.name,
        versionLabel: outline.label,
        date: isoDate(outline.publishedAt ?? 0),
      },
      includeConclusion:
        template.conclusion !== undefined &&
        sections.some(([id]) => id === template.conclusion?.id),
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
    } satisfies Built
  })

const dataUriOf = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })

// NOTE: The images a description names, as data URIs, read through the
// version they belong to (D5). An image that cannot be read is left out and
// the PDF prints a note in its place.
export const imagesOf = (
  reportId: string,
  built: Built,
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.forEach(
    built.description.imageIds,
    imageId =>
      Effect.tryPromise(async signal => {
        const loaded = await loadImage(
          { imageId, reportId, context: built.context },
          signal,
        )
        return Option.isNone(loaded)
          ? Option.none()
          : Option.some([imageId, await dataUriOf(loaded.value.blob)] as const)
      }).pipe(Effect.catch(() => Effect.succeed(Option.none()))),
    { concurrency: 3 },
  ).pipe(Effect.map(found => new Map(Array.getSomes(found))))

export const bytesOfBase64 = base64ToBytes
