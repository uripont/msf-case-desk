// Smoke check for any Case Desk deployment: local workerd, `pnpm infra:dev`
// or a deployed Worker. Read-only.
//
//   node scripts/smoke.mjs <base-url>
//   SMOKE_EMAIL=... SMOKE_PASSWORD=... node scripts/smoke.mjs <base-url>
//
// With an account it also signs in, reads the cases and rules, and signs out.

const base = (process.argv[2] ?? '').replace(/\/$/, '')
if (!/^https?:\/\//.test(base)) {
  console.error('Usage: node scripts/smoke.mjs <base-url>')
  process.exit(2)
}

const results = []
const check = async (name, run) => {
  try {
    await run()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false })
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : error}`)
  }
}

const expect = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const rpc = (tag, cookie) =>
  fetch(`${base}/api/rpc`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ _tag: 'Request', id: '1', tag, payload: null, headers: [] }),
  }).then(response => response.text())

await check('the web app is served', async () => {
  const response = await fetch(`${base}/`)
  expect(response.status === 200, `status ${response.status}`)
  expect((await response.text()).includes('id="root"'), 'no app root in the page')
})

await check('the API answers its health check', async () => {
  const response = await fetch(`${base}/api/health`)
  expect(response.status === 200, `status ${response.status}`)
  expect((await response.json()).status === 'ok', 'unexpected body')
})

await check('there is no session without signing in', async () => {
  const response = await fetch(`${base}/api/session`)
  expect(response.status === 401, `status ${response.status}`)
})

await check('the API refuses requests without a session', async () => {
  expect((await rpc('ListCases')).includes('Unauthorised'), 'not refused')
})

const email = process.env.SMOKE_EMAIL
const password = process.env.SMOKE_PASSWORD

if (email && password) {
  let cookie = ''
  await check('signing in works', async () => {
    const response = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    expect(response.status === 200, `status ${response.status}`)
    cookie = (response.headers.get('set-cookie') ?? '').split(';')[0]
    expect(cookie.startsWith('case_desk_session='), 'no session cookie')
  })
  await check('the session identifies the account', async () => {
    const response = await fetch(`${base}/api/session`, { headers: { cookie } })
    expect(response.status === 200, `status ${response.status}`)
  })
  await check('cases and rule sets can be read', async () => {
    for (const tag of ['ListCases', 'ListRuleSets']) {
      const body = await rpc(tag, cookie)
      expect(body.includes('"_tag":"Success"'), `${tag}: ${body.slice(0, 120)}`)
    }
  })
  await check('signing out ends the session', async () => {
    await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: '{}',
    })
    const response = await fetch(`${base}/api/session`, { headers: { cookie } })
    expect(response.status === 401, `status ${response.status}`)
  })
} else {
  console.log('skip signed-in checks (set SMOKE_EMAIL and SMOKE_PASSWORD)')
}

const failed = results.filter(result => !result.ok).length
console.log(failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} of ${results.length} checks failed.`)
process.exit(failed === 0 ? 0 : 1)
