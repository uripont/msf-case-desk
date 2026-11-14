import {
  DRAFTING_PERMISSIONS,
  type Template,
  TEMPLATE_SCHEMA_VERSION,
} from './template'

// NOTE: The template a new draft starts from (stage 9): one drafting role,
// one reviewing role that votes, and one section. It is valid as it is.

const SHORT_NAME_MAX = 24

// NOTE: always matches the short name pattern: the `t-` prefix a name that
// starts with a digit needs counts toward the 24 characters.
export const slug = (text: string): string => {
  const plain = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (plain === '') {
    return 'template'
  }
  const prefixed = /^[a-z]/.test(plain) ? plain : `t-${plain}`
  const cut = prefixed.slice(0, SHORT_NAME_MAX).replace(/-+$/g, '')
  return cut === 't' ? 'template' : cut
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
