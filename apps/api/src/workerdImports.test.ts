import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { BUILT_IN_TEMPLATES } from '@quoroom/domain'

import { makeNodeSqlite } from './testing/nodeSqlite'
import { workerdImportFiles } from './workerdImports'

const api = join(import.meta.dirname, '..')
const paths = { api, local: '/synthetic/local' }
const everything = () => true

describe('workerd build imports', () => {
  test('pilot embeds the templates and the first-admin grants, in that order', () => {
    expect(workerdImportFiles('pilot', paths, everything)).toEqual([
      join(api, 'seed/builtin-templates.sql'),
      '/synthetic/local/grants-workerd.sql',
    ])
  })

  test('pilot never embeds the demo accounts, and no mode the triage cases', () => {
    const files = workerdImportFiles('pilot', paths, everything)
    expect(files.some(file => file.endsWith('users.sql'))).toBe(false)
    for (const mode of ['demo', 'pilot'] as const) {
      expect(
        workerdImportFiles(mode, paths, everything).some(file =>
          file.endsWith('demo-cases.sql'),
        ),
      ).toBe(false)
    }
  })

  test('pilot without a first-admin file embeds only the templates', () => {
    expect(
      workerdImportFiles('pilot', paths, file => !file.includes('grants')),
    ).toEqual([join(api, 'seed/builtin-templates.sql')])
  })

  test('demo embeds the templates, then accounts and grants', () => {
    expect(workerdImportFiles('demo', paths, everything).map(f => f.split('/').pop())).toEqual([
      'builtin-templates.sql',
      'users.sql',
      'grants-workerd.sql',
    ])
  })

  test('a pilot database from the embedded files has no cases and the two templates', () => {
    const db = makeNodeSqlite()
    workerdImportFiles('pilot', paths, file => file.startsWith(api)).forEach(file =>
      db.raw.exec(readFileSync(file, 'utf8')),
    )
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM cases').get()).toEqual({ n: 0 })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM template_versions').get()).toEqual({
      n: BUILT_IN_TEMPLATES.length,
    })
  })
})
