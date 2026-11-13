import type { TemplateChange } from './api/templates'
import { type Template, templateNodes } from './template'

// NOTE: What changed between two versions of a template (D23), for the audit
// event and the publish confirmation: sections and items added, removed or
// changed (by ID, never by position), roles, and the settings that are not
// structure. Pure: it only reads the two templates. A version with no
// predecessor reports everything as added.

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

// NOTE: a section or item compared without its children, which have changes
// of their own.
const ownPart = (node: object): unknown => {
  const { items, sections, ...rest } = node as Record<string, unknown>
  void items
  void sections
  return rest
}

const labelOf = (node: { id: string; title?: string; label?: string }): string =>
  (node.title ?? node.label ?? node.id).slice(0, 200)

export const diffTemplates = (
  previous: Template | undefined,
  next: Template,
): ReadonlyArray<TemplateChange> => {
  const changes: Array<TemplateChange> = []
  const before = new Map(
    (previous === undefined ? [] : templateNodes(previous)).map(entry => [
      entry.node.id,
      entry,
    ]),
  )
  const after = new Map(templateNodes(next).map(entry => [entry.node.id, entry]))
  for (const [id, entry] of after) {
    const old = before.get(id)
    if (old === undefined) {
      changes.push({
        change: 'added',
        target: entry.kind,
        id,
        label: labelOf(entry.node),
      })
    } else if (!same(ownPart(old.node), ownPart(entry.node))) {
      changes.push({
        change: 'changed',
        target: entry.kind,
        id,
        label: labelOf(entry.node),
      })
    }
  }
  for (const [id, entry] of before) {
    if (!after.has(id)) {
      changes.push({
        change: 'removed',
        target: entry.kind,
        id,
        label: labelOf(entry.node),
      })
    }
  }
  const oldRoles = new Map((previous?.roles ?? []).map(role => [role.id, role]))
  for (const role of next.roles) {
    const old = oldRoles.get(role.id)
    if (old === undefined) {
      changes.push({ change: 'added', target: 'role', id: role.id, label: role.name.slice(0, 200) })
    } else if (!same(old, role)) {
      changes.push({ change: 'changed', target: 'role', id: role.id, label: role.name.slice(0, 200) })
    }
  }
  for (const role of previous?.roles ?? []) {
    if (!next.roles.some(entry => entry.id === role.id)) {
      changes.push({ change: 'removed', target: 'role', id: role.id, label: role.name.slice(0, 200) })
    }
  }
  if (previous !== undefined) {
    if (!same(previous.numbering, next.numbering)) {
      changes.push({ change: 'changed', target: 'numbering', label: 'Numbering' })
    }
    if (!same(previous.cover, next.cover)) {
      changes.push({
        change: previous.cover === undefined ? 'added' : next.cover === undefined ? 'removed' : 'changed',
        target: 'cover',
        label: 'Cover page',
      })
    }
    if (!same(previous.furniture, next.furniture)) {
      changes.push({ change: 'changed', target: 'furniture', label: 'Headers and footers' })
    }
    const settings: ReadonlyArray<readonly [string, keyof Template]> = [
      ['Name', 'name'],
      ['Short name', 'shortName'],
      ['Description', 'description'],
      ['Case reference label', 'caseReferenceLabel'],
      ['Contents depth', 'contentsDepth'],
      ['Page numbering', 'pageNumbering'],
      ['Ending', 'ending'],
    ]
    for (const [label, key] of settings) {
      if (!same(previous[key], next[key])) {
        changes.push({ change: 'changed', target: 'setting', id: key, label })
      }
    }
  }
  return changes.slice(0, 500)
}
