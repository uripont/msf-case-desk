import {
  DRAFTING_PERMISSIONS,
  type Template,
  TEMPLATE_SCHEMA_VERSION,
} from './template'

// NOTE: The template a new draft starts from (stage 9): one drafting role,
// one reviewing role that votes, and one section. It is valid as it is.

export const slug = (text: string): string => {
  const plain = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '')
  return /^[a-z]/.test(plain) ? plain : `t-${plain}`.replace(/-+$/g, '') || 'template'
}

export const blankTemplate = (id: string, name: string): Template => ({
  schemaVersion: TEMPLATE_SCHEMA_VERSION,
  id,
  version: 1,
  name,
  shortName: slug(name),
  caseReferenceLabel: 'Case reference',
  numbering: [{ style: 'arabic', suffix: '.' }],
  roles: [
    {
      id: 'authors',
      name: 'Authors',
      kind: 'drafting',
      view: 'full',
      permissions: DRAFTING_PERMISSIONS,
    },
    {
      id: 'reviewers',
      name: 'Reviewers',
      kind: 'reviewing',
      view: 'redacted',
      permissions: ['comment', 'vote'],
      approval: { kind: 'all' },
    },
  ],
  sections: [
    {
      id: 'summary',
      title: 'Summary',
      requirement: 'required',
      frontMatter: false,
      numbered: true,
      items: [
        { id: 'summary-text', label: 'Summary', requirement: 'required', type: 'rich_text' },
      ],
      sections: [],
    },
  ],
  pageNumbering: 'continuous',
  furniture: {},
})
