import { describe, expect, test } from 'vitest'

import { makeNodeSqlite, migrationFiles } from './testing/nodeSqlite'

// NOTE: 0010 copies every grant into `permission_grants`: an `admin` becomes
// `people` and `theme`, the others stay as they were.
describe('migration 0010, permissions as tabs', () => {
  test('splits admin into people and theme and keeps the other grants', () => {
    const files = migrationFiles()
    const db = makeNodeSqlite(files.slice(0, 9))
    db.raw.exec(`
      INSERT INTO users (id, email, name, password_hash) VALUES
        ('a', 'a@example.org', 'Ana Example', 'x'),
        ('b', 'b@example.org', 'Ben Example', 'x');
      INSERT INTO units (id, name, code, created_at, updated_at) VALUES ('u1', 'Unit One', 'U1', 1, 1);
      INSERT INTO capability_grants (user_id, capability, unit_id, granted_by, granted_at) VALUES
        ('a', 'admin', '', NULL, 5),
        ('a', 'template_editor', '', NULL, 6),
        ('b', 'author', 'u1', 'a', 7);
    `)
    files.slice(9).forEach(sql => db.raw.exec(sql))
    expect(
      db.raw
        .prepare(
          'SELECT user_id, capability, unit_id, granted_by, granted_at FROM permission_grants ORDER BY user_id, capability',
        )
        .all(),
    ).toEqual([
      { user_id: 'a', capability: 'people', unit_id: '', granted_by: null, granted_at: 5 },
      { user_id: 'a', capability: 'template_editor', unit_id: '', granted_by: null, granted_at: 6 },
      { user_id: 'a', capability: 'theme', unit_id: '', granted_by: null, granted_at: 5 },
      { user_id: 'b', capability: 'author', unit_id: 'u1', granted_by: 'a', granted_at: 7 },
    ])
    // NOTE: the old table stays as it was.
    expect(db.raw.prepare('SELECT COUNT(*) AS n FROM capability_grants').get()).toEqual({ n: 3 })
  })
})
