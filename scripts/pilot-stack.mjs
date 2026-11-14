// Commands for the pilot stack (alchemy.pilot.run.ts). Each one names its stage
// explicitly and refuses any other, so a command can never reach the live demo
// stage (`live_uripont`, from .env) by mistake.
//
//   pnpm pilot:plan | pilot:deploy | pilot:destroy     stage "pilot" only
//   pnpm test-env:up   test_<name> [--fast] [--invocation-logs]   throwaway copy
//   pnpm test-env:down test_<name>
//
// --fast gives the test environment notification timings of minutes (D12).
// --invocation-logs turns on the Workers invocation logs of the test Worker,
// which record the CPU time of each request (docs/decisions.md, "Logs and CPU");
// the pilot never has them.
// Extra flags for alchemy are an allowlist (--yes, -y, --dry-run, --detailed);
// anything else is refused, --stage, --config, --env-file, --profile and -p
// included. Every command also runs alchemy with `--profile default` and
// refuses to run when an environment variable (or `.env`) selects another
// profile, account or credentials; see scripts/pilot-guards.mjs.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  ALLOWED_ALCHEMY_FLAGS,
  DEFAULT_PROFILE,
  accountProblems,
  readDotenv,
  refusedFlag,
  removeGrantsFile,
} from './pilot-guards.mjs'

const root = join(import.meta.dirname, '..')
const PILOT_STAGE = 'pilot'
const TEST_STAGE = /^test_[a-z0-9]+$/

const fail = message => {
  console.error(message)
  process.exit(2)
}

const [command, ...rest] = process.argv.slice(2)

// NOTE: before anything else, so no command can reach another account.
const problems = accountProblems(process.env, readDotenv(root))
if (problems.length > 0) {
  fail(
    `Refusing to run: ${problems.join('; ')}.\nThese commands use the Alchemy profile "${DEFAULT_PROFILE}" and the account in it. Unset them (or remove them from .env) to continue.`,
  )
}

const alchemy = (verb, stage, extra, env = {}, capture = false) => {
  const result = spawnSync(
    'pnpm',
    [
      'exec',
      'alchemy',
      verb,
      'alchemy.pilot.run.ts',
      '--stage',
      stage,
      '--profile',
      DEFAULT_PROFILE,
      ...extra,
    ],
    {
      cwd: root,
      stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      env: { ...process.env, ...env, ALCHEMY_STAGE: stage },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
  if (capture) process.stdout.write(result.stdout ?? '')
  return result
}

const pilot = verb => {
  const bad = refusedFlag(rest)
  if (bad) {
    fail(
      `${bad} is not accepted: this command only uses the stage "${PILOT_STAGE}" and the profile "${DEFAULT_PROFILE}". Allowed: ${ALLOWED_ALCHEMY_FLAGS.join(' ')}.`,
    )
  }
  const result = alchemy(verb, PILOT_STAGE, rest)
  process.exit(result.status ?? 1)
}

const testStage = args => {
  const stage = args.find(arg => !arg.startsWith('-')) ?? ''
  if (!TEST_STAGE.test(stage)) {
    fail(
      `Refusing stage "${stage}". test-env only works on a stage like test_<name> (letters and digits).`,
    )
  }
  const flags = args.filter(arg => arg !== stage)
  return { stage, flags }
}

if (command === 'pilot-plan') pilot('plan')
else if (command === 'pilot-deploy') pilot('deploy')
else if (command === 'pilot-destroy') pilot('destroy')
else if (command === 'up' || command === 'down') {
  const { stage, flags } = testStage(rest)
  const fast = flags.includes('--fast')
  const invocationLogs = flags.includes('--invocation-logs')
  const unknown = flags.filter(flag => flag !== '--fast' && flag !== '--invocation-logs')
  if (unknown.length > 0) fail(`Unknown option: ${unknown.join(' ')}`)
  if (command === 'down' && (fast || invocationLogs)) {
    fail('--fast and --invocation-logs only apply to test-env:up.')
  }

  const result = alchemy(
    command === 'up' ? 'deploy' : 'destroy',
    stage,
    ['--yes'],
    command === 'up'
      ? {
          ...(fast ? { QUOROOM_FAST_TIMINGS: '1' } : {}),
          ...(invocationLogs ? { QUOROOM_INVOCATION_LOGS: '1' } : {}),
        }
      : {},
    true,
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
  if (command === 'up') {
    const url = /https:\/\/[a-z0-9.-]+\.workers\.dev/.exec(result.stdout ?? '')?.[0]
    console.log(url ? `\nTest environment ${stage}: ${url}` : `\nDeployed ${stage}; no URL found in the output.`)
  } else {
    console.log(`\nDestroyed ${stage}.`)
    const removed = removeGrantsFile(root, stage)
    if (removed) console.log(`Removed ${removed}.`)
  }
} else {
  fail(
    'Usage: pilot-stack.mjs pilot-plan|pilot-deploy|pilot-destroy | up <test_name> [--fast] [--invocation-logs] | down <test_name>',
  )
}
