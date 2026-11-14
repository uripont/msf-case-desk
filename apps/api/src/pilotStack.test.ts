import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  ACCOUNT_VARIABLES,
  accountProblems,
  grantsFileOf,
  parseDotenv,
  refusedFlag,
  removeGrantsFile,
} from '../../../scripts/pilot-guards.mjs'

// NOTE: the guards of `pnpm pilot:*` and `pnpm test-env:*`. Every case here is
// refused before Alchemy would start, so nothing is deployed.
const script = join(import.meta.dirname, '../../../scripts/pilot-stack.mjs')

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
    ['stray-positional'],
  ])('pilot:deploy refuses %j', (...args) => {
    const result = run(['pilot-deploy', ...args])
    expect(result.status).toBe(2)
    expect(result.text).toContain('is not accepted')
  })

  test('--env-file is refused too (Node itself rejects it before the script runs)', () => {
    expect(refusedFlag(['--env-file'])).toBe('--env-file')
    expect(run(['pilot-deploy', '--env-file', 'x']).status).not.toBe(0)
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
    const root = mkdtempSync(join(tmpdir(), 'pilot-guards-'))
    try {
      mkdirSync(join(root, '.local'))
      const mine = join(root, '.local/grants-test-3fix.sql')
      const other = join(root, '.local/grants-test-other.sql')
      const pilot = join(root, '.local/grants-pilot.sql')
      for (const file of [mine, other, pilot]) writeFileSync(file, '-- invented\n')
      expect(grantsFileOf(root, 'test_3fix')).toBe(mine)
      expect(removeGrantsFile(root, 'test_3fix')).toBe(mine)
      expect(existsSync(mine)).toBe(false)
      expect(existsSync(other)).toBe(true)
      expect(existsSync(pilot)).toBe(true)
      // NOTE: nothing to remove is not an error.
      expect(removeGrantsFile(root, 'test_3fix')).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// NOTE: Cron Triggers (stage 7, D12, D22). Only the demo's `app` and the pilot
// stack's Worker have one, so a frozen version never runs the pass and no
// message is sent twice. The Free plan allows 5 on the account.
describe('Cron Triggers', () => {
  const root = join(import.meta.dirname, '../../..')
  const demo = readFileSync(join(root, 'alchemy.run.ts'), 'utf8')
  const pilot = readFileSync(join(root, 'alchemy.pilot.run.ts'), 'utf8')

  test('the demo stack has one, on `app`, and none on the frozen Workers', () => {
    expect(demo.match(/^\s*crons:/gm)).toHaveLength(1)
    const iter1 = demo.indexOf('Foldkit("Web"')
    const iter2 = demo.indexOf('Foldkit("Iter2"')
    const app = demo.indexOf('Foldkit("App"')
    const cron = demo.indexOf('crons:')
    expect(iter1).toBeGreaterThan(-1)
    expect(app).toBeGreaterThan(iter2)
    expect(cron).toBeGreaterThan(app)
    // NOTE: the Worker `app` is the last resource; nothing follows it but the outputs.
    expect(demo.indexOf('Foldkit(', app + 1)).toBe(-1)
  })

  test('no frozen Worker has a tick secret, and the demo `app` sets none either', () => {
    expect(demo).not.toMatch(/TICK_SECRET\s*:/)
    expect(pilot).not.toMatch(/TICK_SECRET\s*:/)
  })

  test('the pilot stack has one, every minute on the pilot and on test stages; so has the demo `app`', () => {
    expect(pilot.match(/^\s*crons:/gm)).toHaveLength(1)
    expect(pilot).toContain('crons: ["* * * * *"]')
    expect(demo).toContain('crons: ["* * * * *"]')
    expect(demo + pilot).not.toContain('*/5')
  })
})
