import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { BUILT_IN_TEMPLATES } from '@case-desk/domain'

import { builtinTemplatesSql } from './builtinTemplatesSql'
import { makeNodeSqlite } from './testing/nodeSqlite'

const FILE = join(import.meta.dirname, '../seed/builtin-templates.sql')

// NOTE: `pnpm --filter @case-desk/api templates:sql` rewrites the file.
if (process.env['UPDATE_BUILTIN_TEMPLATES'] === '1') {
  writeFileSync(FILE, builtinTemplatesSql())
}

describe('built-in templates import file', () => {
  test('the committed file matches the domain templates', () => {
    expect(readFileSync(FILE, 'utf8')).toBe(builtinTemplatesSql())
  })

  test('importing it twice gives each template and version once, as published', () => {
    const db = makeNodeSqlite()
    const sql = readFileSync(FILE, 'utf8')
    db.raw.exec(sql)
    db.raw.exec(sql)
    const rows = db.raw
      .prepare(
        'SELECT template_id, version, state, definition FROM template_versions ORDER BY template_id',
      )
      .all() as unknown as ReadonlyArray<{
      template_id: string
      version: number
      state: string
      definition: string
    }>
    expect(rows.map(row => row.template_id).sort()).toEqual(
      BUILT_IN_TEMPLATES.map(template => template.id).sort(),
    )
    rows.forEach(row => {
      expect(row.state).toBe('published')
      const template = BUILT_IN_TEMPLATES.find(t => t.id === row.template_id)
      expect(JSON.parse(row.definition)).toEqual(JSON.parse(JSON.stringify(template)))
    })
    expect(
      db.raw.prepare('SELECT COUNT(*) AS n FROM templates WHERE builtin = 1').get(),
    ).toEqual({ n: BUILT_IN_TEMPLATES.length })
  })

  test('a retired built-in version stays retired after a re-import', () => {
    const db = makeNodeSqlite()
    const sql = readFileSync(FILE, 'utf8')
    db.raw.exec(sql)
    db.raw.exec("UPDATE template_versions SET state = 'retired'")
    db.raw.exec(sql)
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM template_versions WHERE state = 'retired'").get(),
    ).toEqual({ n: BUILT_IN_TEMPLATES.length })
  })
})
