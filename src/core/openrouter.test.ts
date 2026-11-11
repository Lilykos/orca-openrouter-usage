import { test, assert } from 'orca/testing'
import {
  createClient,
  getActivity,
  getCredits,
  getKeyMeta,
  listKeys,
  OpenRouterError,
  type OpenRouterClient
} from './openrouter'

const KEY = 'sk-or-v1-SECRETKEY-0123456789'

type Call = { url: string; init: RequestInit }

/** A fake fetch that records every call and answers with `handler(call number, url, init)`. */
function fakeFetch(handler: (n: number, url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = []
  const f = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return handler(calls.length, call.url, call.init)
  }) as unknown as typeof fetch
  return { f, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

/** Recording no-op sleep. */
function recorder() {
  const sleeps: number[] = []
  const sleep = async (ms: number) => {
    sleeps.push(ms)
  }
  return { sleeps, sleep }
}

/** Loads a file from tests/fixtures (the plugin test run starts in the repo root). */
async function fixture<T = any>(name: string): Promise<T> {
  const nodeFs: string = 'node:fs'
  const fs: any = await import(nodeFs)
  const cwd: string = (globalThis as any).process.cwd()
  return JSON.parse(fs.readFileSync(`${cwd}/tests/fixtures/${name}`, 'utf8'))
}

async function rejection(p: Promise<unknown>): Promise<OpenRouterError> {
  try {
    await p
  } catch (e) {
    assert.ok(e instanceof OpenRouterError, 'expected an OpenRouterError')
    return e
  }
  return assert.fail('expected the call to reject')
}

function clientWith(f: typeof fetch, sleep: (ms: number) => Promise<void>): OpenRouterClient {
  return createClient({ key: KEY, fetch: f, sleep })
}

test('sends the bearer key and only GET requests', async () => {
  const { f, calls } = fakeFetch(() => json({ data: { total_credits: 1, total_usage: 0 } }))
  const { sleep } = recorder()
  const c = clientWith(f, sleep)
  await getCredits(c)
  assert.equal(calls.length, 1)
  const headers = calls[0].init.headers as Record<string, string>
  assert.equal(headers.Authorization, `Bearer ${KEY}`)
  assert.equal(calls[0].init.method, 'GET')
  assert.ok(calls[0].url.startsWith('https://openrouter.ai/api/v1/credits'))
  assert.deepEqual(Object.keys(c), ['get'])
})

test('getCredits parses the credits fixture', async () => {
  const body = await fixture('credits.json')
  const { f } = fakeFetch(() => json(body))
  const got = await getCredits(clientWith(f, recorder().sleep))
  assert.deepEqual(got, { totalCredits: body.data.total_credits, totalUsage: body.data.total_usage })
})

test('getKeyMeta parses the management key fixture', async () => {
  const body = await fixture('key-mgmt.json')
  const { f, calls } = fakeFetch(() => json(body))
  const got = await getKeyMeta(clientWith(f, recorder().sleep))
  assert.deepEqual(got, { isManagement: true, label: 'sk-or-v1-abc...xyz' })
  assert.ok(calls[0].url.endsWith('/key'))
})

test('listKeys returns every key from the keys fixture in one short page', async () => {
  const body = await fixture('keys.json')
  const { f, calls } = fakeFetch(() => json(body))
  const keys = await listKeys(clientWith(f, recorder().sleep))
  assert.equal(keys.length, body.data.length)
  assert.equal(keys[0].hash, body.data[0].hash)
  assert.ok(calls[0].url.includes('include_disabled=true'))
  assert.ok(calls[0].url.includes('offset=0'))
})

test('listKeys paginates until a short page', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ hash: `full-${i}` }))
  const rest = Array.from({ length: 5 }, (_, i) => ({ hash: `rest-${i}` }))
  const { f, calls } = fakeFetch((n) => json({ data: n === 1 ? full : rest }))
  const keys = await listKeys(clientWith(f, recorder().sleep))
  assert.equal(keys.length, 105)
  assert.equal(calls.length, 2)
  assert.ok(calls[0].url.includes('offset=0'))
  assert.ok(calls[1].url.includes('offset=100'))
})

test('listKeys stops on an empty page after a full one', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ hash: `h${i}` }))
  const { f, calls } = fakeFetch((n) => json({ data: n === 1 ? full : [] }))
  const keys = await listKeys(clientWith(f, recorder().sleep))
  assert.equal(keys.length, 100)
  assert.equal(calls.length, 2)
})

test('listKeys caps pagination at 20 pages', async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ hash: `h${i}` }))
  const { f, calls } = fakeFetch(() => json({ data: full }))
  const keys = await listKeys(clientWith(f, recorder().sleep))
  assert.equal(calls.length, 20)
  assert.equal(keys.length, 2000)
})

test('getActivity returns all fixture rows without a date, and passes date when given', async () => {
  const body = await fixture('activity.json')
  const { f, calls } = fakeFetch(() => json(body))
  const c = clientWith(f, recorder().sleep)
  const rows = await getActivity(c)
  assert.equal(rows.length, 214)
  assert.ok(!calls[0].url.includes('date='))
  await getActivity(c, '2026-11-09')
  assert.ok(calls[1].url.includes('date=2026-11-09'))
})

test('401 maps to unauthorized without retrying', async () => {
  const { f, calls } = fakeFetch(() => json({ error: 'nope' }, 401))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getCredits(clientWith(f, sleep)))
  assert.equal(err.code, 'unauthorized')
  assert.equal(err.status, 401)
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('403 maps to forbidden without retrying', async () => {
  const { f, calls } = fakeFetch(() => json({ error: 'no' }, 403))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getKeyMeta(clientWith(f, sleep)))
  assert.equal(err.code, 'forbidden')
  assert.equal(err.status, 403)
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
})

test('other 4xx responses are not retried', async () => {
  const { f, calls } = fakeFetch(() => json({}, 404))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getCredits(clientWith(f, sleep)))
  assert.equal(calls.length, 1)
  assert.deepEqual(sleeps, [])
  assert.equal(err.status, 404)
})

test('500 is retried twice with backoff, then maps to server', async () => {
  const { f, calls } = fakeFetch(() => json({}, 500))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getCredits(clientWith(f, sleep)))
  assert.equal(err.code, 'server')
  assert.equal(err.status, 500)
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 2000])
})

test('500 then success returns the data', async () => {
  const { f, calls } = fakeFetch((n) => (n === 1 ? json({}, 503) : json({ data: { total_credits: 2, total_usage: 1 } })))
  const { sleeps, sleep } = recorder()
  const got = await getCredits(clientWith(f, sleep))
  assert.deepEqual(got, { totalCredits: 2, totalUsage: 1 })
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [1000])
})

test('429 then success sleeps for the Retry-After seconds', async () => {
  const { f, calls } = fakeFetch((n) =>
    n === 1 ? json({}, 429, { 'retry-after': '7' }) : json({ data: { total_credits: 5, total_usage: 2 } })
  )
  const { sleeps, sleep } = recorder()
  const got = await getCredits(clientWith(f, sleep))
  assert.deepEqual(got, { totalCredits: 5, totalUsage: 2 })
  assert.equal(calls.length, 2)
  assert.deepEqual(sleeps, [7000])
})

test('429 without Retry-After backs off 1s, 2s, 4s then gives up as rate_limited', async () => {
  const { f, calls } = fakeFetch(() => json({}, 429))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getCredits(clientWith(f, sleep)))
  assert.equal(err.code, 'rate_limited')
  assert.equal(err.status, 429)
  assert.equal(calls.length, 4)
  assert.deepEqual(sleeps, [1000, 2000, 4000])
})

test('a long Retry-After fails fast as rate_limited instead of stalling the refresh', async () => {
  const { f, calls } = fakeFetch(() => json({}, 429, { 'retry-after': '3600' }))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getCredits(clientWith(f, sleep)))
  assert.equal(err.code, 'rate_limited')
  assert.equal(err.retryAfterMs, 3_600_000)
  assert.deepEqual(sleeps, []) // never slept for an hour
  assert.equal(calls.length, 1)
})

test('a short Retry-After is still honoured up to the three retries', async () => {
  const { f } = fakeFetch(() => json({}, 429, { 'retry-after': '8' }))
  const { sleeps, sleep } = recorder()
  const err = await rejection(getCredits(clientWith(f, sleep)))
  assert.equal(err.code, 'rate_limited')
  assert.deepEqual(sleeps, [8000, 8000, 8000])
})

test('a thrown fetch maps to network, with no key in the message', async () => {
  const { f } = fakeFetch(() => {
    throw new TypeError(`fetch failed for Bearer ${KEY}`)
  })
  const err = await rejection(getCredits(clientWith(f, recorder().sleep)))
  assert.equal(err.code, 'network')
  assert.equal(err.status, 0)
  assert.ok(!err.message.includes(KEY))
})

test('a non-JSON body maps to bad_response', async () => {
  const { f } = fakeFetch(() => new Response('<html>oops</html>', { status: 200 }))
  const err = await rejection(getActivity(clientWith(f, recorder().sleep)))
  assert.equal(err.code, 'bad_response')
})

test('a body without the expected data maps to bad_response', async () => {
  const { f } = fakeFetch(() => json({ nothing: true }))
  const c = clientWith(f, recorder().sleep)
  assert.equal((await rejection(getCredits(c))).code, 'bad_response')
  assert.equal((await rejection(getKeyMeta(c))).code, 'bad_response')
  assert.equal((await rejection(listKeys(c))).code, 'bad_response')
  assert.equal((await rejection(getActivity(c))).code, 'bad_response')
})

test('error messages never contain the API key', async () => {
  const responses: (() => Response | Promise<Response>)[] = [
    () => json({ error: KEY }, 401),
    () => json({ error: KEY }, 403),
    () => json({ error: KEY }, 404),
    () => json({ error: KEY }, 500),
    () => json({ error: KEY }, 429),
    () => json({ data: KEY }, 200)
  ]
  for (const respond of responses) {
    const { f } = fakeFetch(respond)
    const err = await rejection(getCredits(clientWith(f, recorder().sleep)))
    assert.ok(!err.message.includes(KEY), `message leaked the key: ${err.message}`)
    assert.ok(!err.message.includes('Bearer'), `message leaked the header: ${err.message}`)
  }
  const { f } = fakeFetch(() => {
    throw new Error(`socket reset with ${KEY}`)
  })
  const err = await rejection(getCredits(clientWith(f, recorder().sleep)))
  assert.ok(!err.message.includes(KEY))
})
