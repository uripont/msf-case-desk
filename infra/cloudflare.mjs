// Commands for Quoroom on Cloudflare (infra/cloudflare.run.ts). Each one names
// its stage explicitly and refuses any other, so a command can never reach the
// course's demo stage (`live_<user>`, from .env) by mistake.
//
//   pnpm cloudflare:plan | cloudflare:deploy | cloudflare:destroy [stage]
//       stage: letters and digits, default `quoroom` (the MSF pilot is `pilot`)
//   pnpm test-env:up   test_<name> [--fast] [--invocation-logs]   throwaway copy
//   pnpm test-env:down test_<name>
//
// --fast gives the test environment notification timings of minutes (D12).
// --invocation-logs turns on the Workers invocation logs of the test Worker,
// which record the CPU time of each request (docs/decisions.md, "Logs and CPU");
// other stages never have them.
// Extra flags for alchemy are an allowlist (--yes, -y, --dry-run, --detailed);
// anything else is refused, --stage, --config, --env-file, --profile and -p
// included. Every command also runs alchemy with `--profile default` and
// refuses to run when an environment variable (or `.env`) selects another
// profile, account or credentials; see infra/guards.mjs.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import {
  ALLOWED_ALCHEMY_FLAGS,
  DEFAULT_PROFILE,
  accountProblems,
  readDotenv,
  refusedFlag,
  removeGrantsFile,
} from './guards.mjs'

const root = join(import.meta.dirname, '..')
const DEFAULT_STAGE = 'quoroom'
const STAGE = /^[a-z][a-z0-9]*$/
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
      'infra/cloudflare.run.ts',
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

// NOTE: one optional positional, the stage; the rest must be allowed flags.
const deployment = verb => {
  const positionals = rest.filter(arg => !arg.startsWith('-'))
  const flags = rest.filter(arg => arg.startsWith('-'))
  const bad = refusedFlag(flags)
  if (bad) {
    fail(
      `${bad} is not accepted: this command chooses the stage and uses the profile "${DEFAULT_PROFILE}". Allowed: ${ALLOWED_ALCHEMY_FLAGS.join(' ')}.`,
    )
  }
  const stage = positionals[0] ?? DEFAULT_STAGE
  if (positionals.length > 1 || !STAGE.test(stage)) {
    fail(
      `Refusing stage "${positionals.join(' ')}". A stage is letters and digits, such as quoroom or pilot; test environments use test-env:up.`,
    )
  }
  const result = alchemy(verb, stage, flags)
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

if (command === 'plan' || command === 'deploy' || command === 'destroy') deployment(command)
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
    'Usage: cloudflare.mjs plan|deploy|destroy [stage] | up <test_name> [--fast] [--invocation-logs] | down <test_name>',
  )
}
