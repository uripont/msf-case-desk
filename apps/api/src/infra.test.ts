import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

import { BUILT_IN_TEMPLATES } from '@quoroom/domain'

import {
  ACCOUNT_VARIABLES,
  accountProblems,
  grantsFileOf,
  parseDotenv,
  refusedFlag,
  removeGrantsFile,
} from '../../../infra/guards.mjs'
import { ASSETS_DIR, CONFIG_DIR, flagValue, wranglerConfig } from '../../../infra/openorange.ts'
import {
  BUILTIN_TEMPLATES,
  MIGRATIONS,
  NOTIFICATION_CRON,
  TIMINGS,
  WEB_ASSETS,
  WORKER_ENTRY,
  importFiles,
  timingVariables,
} from '../../../infra/quoroom.ts'

import { makeNodeSqlite } from './testing/nodeSqlite'

const root = join(import.meta.dirname, '../../..')
const source = (file: string) => readFileSync(join(root, file), 'utf8')

// NOTE: the guards of `pnpm cloudflare:*` and `pnpm test-env:*`. Every case
// here is refused before Alchemy would start, so nothing is deployed.
const script = join(root, 'infra/cloudflare.mjs')

const run = (args: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const result = spawnSync('node', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  })
  return { status: result.status, text: `${result.stdout}${result.stderr}` }
}

describe('alchemy flags are an allowlist', () => {
  test.each([
    ['--stage', 'live_x'],
    ['--stage=live_x'],
    ['--config', 'x.ts'],
    ['--profile', 'other'],
    ['--profile=other'],
    ['-p'],
    ['-c'],
    ['--adopt'],
    ['--force'],
    ['--some-future-flag'],
  ])('cloudflare:deploy refuses %j', (...args) => {
    const result = run(['deploy', 'pilot', ...args])
    expect(result.status).toBe(2)
    expect(result.text).toContain('is not accepted')
  })

  test.each([['live_x'], ['test_x'], ['Pilot'], ['pilot', 'quoroom']])(
    'cloudflare:deploy refuses the stage %j',
    (...args) => {
      const result = run(['deploy', ...args])
      expect(result.status).toBe(2)
      expect(result.text).toContain('Refusing stage')
    },
  )

  test('--env-file is refused too (Node itself rejects it before the script runs)', () => {
    expect(refusedFlag(['--env-file'])).toBe('--env-file')
    expect(run(['deploy', '--env-file', 'x']).status).not.toBe(0)
  })

  test('the allowed flags pass the check', () => {
    expect(refusedFlag(['--yes', '-y', '--dry-run', '--detailed'])).toBeUndefined()
    expect(refusedFlag(['--yes', '--profile'])).toBe('--profile')
  })

  test.each([['--profile', 'other'], ['-p', 'other'], ['--stage', 'live_x'], ['--other-flag']])(
    'test-env:up refuses %j',
    (...flags) => {
      expect(run(['up', 'test_x', ...flags]).status).toBe(2)
    },
  )

  test('test-env:up refuses a stage that is not a test stage', () => {
    expect(run(['up', 'pilot']).status).toBe(2)
  })
})

describe('the account is the one of the default profile', () => {
  test.each(ACCOUNT_VARIABLES.map(name => [name]))('refuses when %s is set in the environment', name => {
    const result = run(['up', 'test_x'], { [name]: 'something-else' })
    expect(result.status).toBe(2)
    expect(result.text).toContain(`${name} is set in the environment`)
    expect(result.text).not.toContain('something-else')
  })

  test('the default profile name and unset values are fine, anything else in .env or the environment is not', () => {
    expect(accountProblems({ ALCHEMY_PROFILE: 'default' }, {})).toEqual([])
    expect(accountProblems({ CLOUDFLARE_ACCOUNT_ID: '' }, { ALCHEMY_STAGE: 'live_x' })).toEqual([])
    expect(accountProblems({ ALCHEMY_PROFILE: 'other' }, {})).toEqual([
      'ALCHEMY_PROFILE is set in the environment',
    ])
    expect(
      accountProblems({}, { ALCHEMY_PROFILE: 'work', CLOUDFLARE_ACCOUNT_ID: 'abc' }),
    ).toEqual(['ALCHEMY_PROFILE is set in .env', 'CLOUDFLARE_ACCOUNT_ID is set in .env'])
  })

  test('.env lines are read as Alchemy reads them', () => {
    expect(
      parseDotenv(
        [
          '# a comment',
          'ALCHEMY_STAGE=live_x',
          'export ALCHEMY_PROFILE="work"',
          "CLOUDFLARE_ACCOUNT_ID='abc' # trailing",
          '',
          'not a line',
        ].join('\n'),
      ),
    ).toEqual({
      ALCHEMY_STAGE: 'live_x',
      ALCHEMY_PROFILE: 'work',
      CLOUDFLARE_ACCOUNT_ID: 'abc',
    })
  })
})

describe('test-env:down removes the grants file of that environment', () => {
  test('only the file of the destroyed environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quoroom-guards-'))
    try {
      mkdirSync(join(dir, '.local'))
      const mine = join(dir, '.local/grants-test-3fix.sql')
      const other = join(dir, '.local/grants-test-other.sql')
      const pilot = join(dir, '.local/grants-pilot.sql')
      for (const file of [mine, other, pilot]) writeFileSync(file, '-- invented\n')
      expect(grantsFileOf(dir, 'test_3fix')).toBe(mine)
      expect(removeGrantsFile(dir, 'test_3fix')).toBe(mine)
      expect(existsSync(mine)).toBe(false)
      expect(existsSync(other)).toBe(true)
      expect(existsSync(pilot)).toBe(true)
      // NOTE: nothing to remove is not an error.
      expect(removeGrantsFile(dir, 'test_3fix')).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// NOTE: what an environment's database imports after the migrations, the same
// list on every host (infra/quoroom.ts).
describe('imports', () => {
  const withLocal = (files: ReadonlyArray<string>, check: (local: string) => void) => {
    const local = mkdtempSync(join(tmpdir(), 'quoroom-local-'))
    try {
      for (const file of files) writeFileSync(join(local, file), '-- invented\n')
      check(local)
    } finally {
      rmSync(local, { recursive: true, force: true })
    }
  }
  const names = (files: ReadonlyArray<string>) => files.map(file => file.split('/').pop())

  test('a deployment imports the templates, then its own first administrator', () => {
    withLocal(['users.sql', 'grants-pilot.sql', 'grants-workerd.sql'], local => {
      expect(importFiles('pilot', { local })).toEqual([BUILTIN_TEMPLATES, join(local, 'grants-pilot.sql')])
      expect(names(importFiles('workerd', { local }))).toEqual(['builtin-templates.sql', 'grants-workerd.sql'])
    })
  })

  test('without a first-administrator file, only the templates', () => {
    withLocal([], local => {
      expect(importFiles('openorange', { local })).toEqual([BUILTIN_TEMPLATES])
    })
  })

  test('only demo data has the accounts of `pnpm users:add`, after the templates', () => {
    withLocal(['users.sql', 'grants-workerd.sql'], local => {
      expect(names(importFiles('workerd', { demoAccounts: true, local }))).toEqual([
        'builtin-templates.sql',
        'users.sql',
        'grants-workerd.sql',
      ])
    })
  })

  test('no host imports the triage cases; only the demo stack names them, last', () => {
    for (const file of ['infra/cloudflare.run.ts', 'infra/openorange.ts', 'apps/api/scripts/build-workerd.mjs']) {
      expect(source(file)).not.toContain('DEMO_CASES')
    }
    expect(source('infra/demo.run.ts')).toContain(
      'importFiles: [...importFiles("demo", { demoAccounts: true }), DEMO_CASES]',
    )
  })

  test('a database from the imports has no cases and the built-in templates', () => {
    withLocal([], local => {
      const db = makeNodeSqlite()
      for (const file of importFiles('pilot', { local })) db.raw.exec(readFileSync(file, 'utf8'))
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM cases').get()).toEqual({ n: 0 })
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
      expect(db.raw.prepare('SELECT COUNT(*) AS n FROM template_versions').get()).toEqual({
        n: BUILT_IN_TEMPLATES.length,
      })
    })
  })
})

// NOTE: Cron Triggers (D12, D22). The demo's `app` and each Quoroom
// deployment have one, so a frozen version never runs the pass and no message
// is sent twice. The Free plan allows 5 on the account.
describe('Cron Triggers and logs', () => {
  const demo = source('infra/demo.run.ts')
  const cloudflare = source('infra/cloudflare.run.ts')

  test('the pass runs every minute, from one constant', () => {
    expect(NOTIFICATION_CRON).toBe('* * * * *')
    expect(demo + cloudflare).not.toContain('*/5')
    expect(wranglerConfig().triggers.crons).toEqual([NOTIFICATION_CRON])
  })

  test('the demo stack has one, on `app`, and none on the frozen Workers', () => {
    expect(demo.match(/^\s*crons:/gm)).toHaveLength(1)
    const iter1 = demo.indexOf('Foldkit("Web"')
    const iter2 = demo.indexOf('Foldkit("Iter2"')
    const app = demo.indexOf('Foldkit("App"')
    const cron = demo.indexOf('crons: [NOTIFICATION_CRON]')
    expect(iter1).toBeGreaterThan(-1)
    expect(app).toBeGreaterThan(iter2)
    expect(cron).toBeGreaterThan(app)
    // NOTE: the Worker `app` is the last resource; nothing follows it but the outputs.
    expect(demo.indexOf('Foldkit(', app + 1)).toBe(-1)
  })

  test('the Cloudflare stack has one Worker with one', () => {
    expect(cloudflare.match(/Foldkit\(/g)).toHaveLength(1)
    expect(cloudflare.match(/^\s*crons:/gm)).toHaveLength(1)
    expect(cloudflare).toContain('crons: [NOTIFICATION_CRON]')
  })

  test('no Worker has a tick secret', () => {
    expect(demo + cloudflare).not.toMatch(/TICK_SECRET\s*:/)
    expect(JSON.stringify(wranglerConfig())).not.toContain('TICK_SECRET')
  })

  // NOTE: D7: a deployment's logs keep what the code writes (errors included)
  // and never the request URL, headers or body. Only a test stage may turn
  // invocation logs on, for the CPU measurements.
  test('Workers Logs with no invocation logs or traces; only a test stage can turn them on', () => {
    expect(cloudflare).toContain('logs: { enabled: true, invocationLogs, persist: true }')
    expect(cloudflare).toContain('traces: { enabled: false }')
    expect(cloudflare).toContain(
      'const invocationLogs = isTest && process.env.QUOROOM_INVOCATION_LOGS === "1";',
    )
    expect(cloudflare.match(/observability/g)?.length).toBe(3)
    expect(cloudflare).toContain('observability: observabilityFor(invocationLogs),')
  })

  test('fast timings only on a test stage', () => {
    expect(cloudflare).toContain(
      'const timings = isTest && process.env.QUOROOM_FAST_TIMINGS === "1" ? TIMINGS.fast : TIMINGS.production;',
    )
  })
})

// NOTE: OpenOrange gets the same Worker as Cloudflare, from infra/quoroom.ts.
describe('the OpenOrange configuration', () => {
  const config = wranglerConfig()
  const at = (path: string) => resolve(CONFIG_DIR, path)

  test('the same entry, assets, migrations and bindings', () => {
    expect(at(config.main)).toBe(WORKER_ENTRY)
    expect(at(config.assets.directory)).toBe(ASSETS_DIR)
    expect(config.assets.binding).toBe('ASSETS')
    expect(config.d1_databases).toHaveLength(1)
    expect(config.d1_databases[0]?.binding).toBe('DB')
    expect(at(config.d1_databases[0]?.migrations_dir ?? '')).toBe(MIGRATIONS)
  })

  test('the web build is copied inside the folder of the configuration, the only one `orange deploy` packages', () => {
    expect(relative(CONFIG_DIR, ASSETS_DIR)).toBe('assets')
    expect(relative(root, WEB_ASSETS)).toBe('apps/web/dist')
  })

  test('the Worker answers every request, so it sets the headers that `_headers` sets on Cloudflare', () => {
    expect(config.assets.run_worker_first).toBe(true)
    expect(config.assets.not_found_handling).toBe('single-page-application')
  })

  test('production timings unless --fast', () => {
    expect(config.vars).toEqual(timingVariables(TIMINGS.production))
    expect(wranglerConfig({ fast: true }).vars).toEqual(timingVariables(TIMINGS.fast))
  })

  test('`database` finds its cluster in either flag form', () => {
    expect(flagValue(['--cluster', 'prod', '--region', 'eu'], '--cluster')).toBe('prod')
    expect(flagValue(['--org=example', '--cluster=prod'], '--org')).toBe('example')
    expect(flagValue(['--dry-run', '--outdir', 'out'], '--cluster')).toBeUndefined()
  })
})
