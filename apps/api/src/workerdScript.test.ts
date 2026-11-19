import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

// NOTE: the argument parsing of `pnpm workerd` (infra/workerd.sh), without
// building or starting anything (`WORKERD_PARSE_ONLY`).
const script = join(import.meta.dirname, '../../../infra/workerd.sh')

const run = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WORKERD_PARSE_ONLY: '1' },
  })
  return { status: result.status, out: result.stdout.trim() }
}

describe('infra/workerd.sh arguments', () => {
  test.each([
    [[], 'demo 8787'],
    [['8790'], 'demo 8790'],
    [['--mode', 'pilot'], 'pilot 8787'],
    [['--mode=pilot'], 'pilot 8787'],
    [['8790', '--mode', 'pilot'], 'pilot 8790'],
    [['8790', '--mode=pilot'], 'pilot 8790'],
    [['--mode=demo', '8791'], 'demo 8791'],
  ])('%j', (args, expected) => {
    expect(run(...args)).toEqual({ status: 0, out: expected })
  })

  test.each([
    [['--mode']],
    [['--mode=']],
    [['--mode', 'staging']],
    [['--mode=Pilot']],
    [['--pilot']],
    [['--mode', 'pilot', '--fast']],
    [['8790', '8791']],
    [['abc']],
  ])('refuses %j', args => {
    expect(run(...args).status).toBe(2)
  })
})
