import { blankTemplate } from './blank-template'
import { CONTENT_SCHEMA_VERSION, type ReportContent } from './content'
import { type DocumentInput } from './document'
import { type Template } from './template'
import { type Theme } from './theme'

// NOTE: The invented document the theme screen previews a PDF with: one
// section of two paragraphs, a table-free body that fits one page
// after the cover. It carries no report content and no real name; the
// organisation's name, logo, colours, fonts and header and footer come from
// the theme being edited, so the preview shows what the next PDF will.

export const SAMPLE_TEMPLATE: Template = {
  ...blankTemplate('sample-report', 'Sample report'),
  furniture: {},
}

const paragraph = (text: string) => ({
  type: 'paragraph' as const,
  content: [{ type: 'text' as const, text }],
})

export const SAMPLE_CONTENT: ReportContent = {
  schemaVersion: CONTENT_SCHEMA_VERSION,
  templateId: SAMPLE_TEMPLATE.id,
  templateVersion: SAMPLE_TEMPLATE.version,
  sections: {
    summary: {
      values: {
        'summary-text': {
          type: 'rich_text',
          doc: {
            type: 'doc',
            content: [
              paragraph(
                'This is a sample paragraph. It shows how the body text of a report looks in the chosen font and colour, and how a heading looks above it.',
              ),
              paragraph(
                'A second paragraph follows, so the page has some text between its header and its footer. Nothing here is a real report.',
              ),
            ],
          },
        },
      },
      sections: {},
    },
  },
}

export const sampleDocumentInput = (theme: Theme): DocumentInput => ({
  template: SAMPLE_TEMPLATE,
  content: SAMPLE_CONTENT,
  view: { kind: 'original', people: [] },
  caseFile: {
    reference: 'SAMPLE-0001',
    unit: '',
    title: 'Sample case file',
  },
  theme,
  version: {
    reportName: 'Sample report',
    versionLabel: 'Revision 1',
    date: '2026-01-15',
  },
})
