// Rejects migrations that would break a frozen version reading the shared
// database: see docs/compatibility.md. Usage: node scripts/check-migrations.mjs [dir]
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const dir = process.argv[2] ?? join(root, 'apps/api/migrations')

const stripComments = sql =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')

const statements = sql =>
  stripComments(sql)
    .split(';')
    .map(statement => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

const rules = [
  [/^DROP\b/i, 'drops a table, index or view'],
  [/\bRENAME\b/i, 'renames a table or column'],
  [/^ALTER TABLE \S+ DROP\b/i, 'drops a column'],
  [/^ALTER TABLE \S+ ALTER\b/i, 'changes a column'],
  [/^UPDATE\b|^DELETE\b/i, 'rewrites existing rows'],
  [
    statement =>
      /^ALTER TABLE \S+ ADD\b/i.test(statement) &&
      /\bNOT NULL\b/i.test(statement) &&
      !/\bDEFAULT\b/i.test(statement),
    'adds a NOT NULL column without a default',
  ],
]

export const problemsIn = sql =>
  statements(sql).flatMap(statement =>
    rules
      .filter(([rule]) =>
        typeof rule === 'function' ? rule(statement) : rule.test(statement),
      )
      .map(([, message]) => `${message}: ${statement.slice(0, 80)}`),
  )

const frozenTags = () => {
  try {
    return execFileSync('git', ['-C', root, 'tag', '--list', 'iter*'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean)
  } catch {
    return []
  }
}

const frozenContent = (tag, path) => {
  try {
    return execFileSync('git', ['-C', root, 'show', `${tag}:${path}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return undefined
  }
}

const files = readdirSync(dir)
  .filter(file => file.endsWith('.sql'))
  .sort()

const problems = files.flatMap(file => {
  const path = join(dir, file)
  const sql = readFileSync(path, 'utf8')
  const repoPath = relative(root, path)
  const changedSinceTag = frozenTags().flatMap(tag => {
    const frozen = frozenContent(tag, repoPath)
    return frozen !== undefined && frozen !== sql
      ? [`was changed after ${tag} froze it; add a new migration instead`]
      : []
  })
  return [...problemsIn(sql), ...changedSinceTag].map(
    problem => `${file}: ${problem}`,
  )
})

const numbering = files.filter(file => !/^\d{4}_[a-z0-9_]+\.sql$/.test(file))

if (problems.length > 0 || numbering.length > 0) {
  problems.forEach(problem => console.error(problem))
  numbering.forEach(file =>
    console.error(`${file}: name it NNNN_description.sql`),
  )
  process.exit(1)
}

console.log(`${files.length} migrations are expand-only`)
