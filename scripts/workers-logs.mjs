// Reads the Workers Logs of one test Worker through the Workers observability
// API, with the credentials of the Alchemy profile `default`. Never prints the
// token or the account ID. Used by the log test and the CPU measurements of
// stage 10 (docs/decisions.md, "Stage 10: log test and CPU").
//
//   node scripts/workers-logs.mjs events <worker> --from <ms|ISO> [--to <ms|ISO>] --out <file.json>
//       every event of the window, written to a file (the events can hold
//       invented text of a test; nothing is printed but counts)
//   node scripts/workers-logs.mjs search <worker> --from <...> --markers <file.json> [--to <...>]
//       free-text search of the window for each marker string, by the API and
//       over every event pulled; prints a count per marker, never the events
//
// Only Workers named test-*: it refuses anything else (never the pilot, the
// demo or iteration workers).
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string' },
    markers: { type: 'string' },
  },
})
const [command, worker] = positionals
if (!['events', 'search'].includes(command ?? '') || !/^test-[a-z0-9]+-pilot$/.test(worker ?? '')) {
  console.error('Usage: workers-logs.mjs events|search <test-NAME-pilot> --from <time> [--to <time>] ...')
  process.exit(2)
}
const time = (value, fallback) => {
  if (value === undefined) return fallback
  const n = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(n)) throw new Error(`bad time ${value}`)
  return n
}
const from = time(values.from, Date.now() - 3600_000)
const to = time(values.to, Date.now())

const profile = JSON.parse(
  readFileSync(join(homedir(), '.alchemy/profiles/default/cloudflare.json'), 'utf8'),
).values
const url = `https://api.cloudflare.com/client/v4/accounts/${profile.accountId}/workers/observability/telemetry/query`

const query = async (parameters, offset) => {
  const body = {
    queryId: 'events',
    timeframe: { from, to },
    view: 'events',
    limit: 200,
    // NOTE: no `orderBy`, `calculations` or `groupBys` in an events query: with
    // them the API answered with no events at all.
    parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$metadata.service', operation: 'eq', type: 'string', value: worker }], ...parameters },
    ...(offset === undefined ? {} : { offset, offsetBy: 0, offsetDirection: 'next' }),
  }
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${profile.apiToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await response.json().catch(() => ({}))
    if (response.ok && json.success !== false) return json.result
    if (attempt >= 3) throw new Error(`observability query failed: HTTP ${response.status} ${JSON.stringify(json.errors ?? []).slice(0, 300)}`)
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
}

const pull = async parameters => {
  const events = []
  let offset
  for (;;) {
    const result = await query(parameters, offset)
    const page = result?.events?.events ?? []
    events.push(...page)
    if (page.length < 200) break
    offset = page[page.length - 1]?.$metadata?.id
    if (offset === undefined) break
  }
  return events.sort((a, b) => a.timestamp - b.timestamp)
}

if (command === 'events') {
  const events = await pull({})
  writeFileSync(values.out ?? 'events.json', JSON.stringify(events))
  console.log(`${events.length} events written`)
} else {
  const markers = JSON.parse(readFileSync(values.markers, 'utf8'))
  const all = await pull({})
  const text = all.map(event => JSON.stringify(event).toLowerCase())
  console.log(`events in window: ${all.length}`)
  let found = 0
  for (const marker of markers) {
    const local = text.filter(line => line.includes(marker.toLowerCase())).length
    const remote = (await pull({ needle: { value: marker, matchCase: false, isRegex: false } })).length
    found += local + remote
    console.log(`${local + remote === 0 ? 'clean' : 'FOUND'}  local ${local}  api ${remote}  (marker ${markers.indexOf(marker) + 1} of ${markers.length})`)
  }
  console.log(found === 0 ? 'RESULT: no marker found' : 'RESULT: MARKERS FOUND')
  process.exit(found === 0 ? 0 : 1)
}
