// Runs src/worker.ts over a mock host with OpenRouter faked at the fetch boundary.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
// @ts-ignore node typings are not shipped with Orca's test kit
import { readFileSync } from 'node:fs'
import * as main from './worker'
import type { Report, Settings, Status } from './protocol'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8'))

const MGMT = 'sk-or-v1-fake-management-key'
const QUERY = { range: '30d', measure: 'cost' } as const

// Fixture keys with the first two stamped as used just now (the real fixture dates age out).
function recentKeys(bump = 0, byokDaily = 0): unknown {
  const body = fixture('keys') as { data: { usage: number; last_used_at: string | null }[] }
  const data = body.data.map((k, i) => (i < 2 ? { ...k, usage: Math.max(k.usage, 1) + bump, byok_usage_daily: i === 0 ? byokDaily : 0, last_used_at: new Date().toISOString() } : { ...k, last_used_at: null }))
  return { data }
}

// Keep the fixture's newest completed day at yesterday, independent of the test run date.
function recentActivity(): unknown {
  const body = fixture('activity') as { data: { date: string }[] }
  const latest = Math.max(...body.data.map((r) => Date.parse(r.date.slice(0, 10) + 'T00:00:00Z')))
  const yesterday = Date.parse(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z')
  return { data: body.data.map((r) => ({ ...r, date: new Date(Date.parse(r.date.slice(0, 10) + 'T00:00:00Z') + yesterday - latest).toISOString().slice(0, 10) })) }
}

// Routes by path; `managementKey: false` makes /key report a regular key, `fail` makes every call 401.
function fakeFetch(opts: { managementKey?: boolean; fail?: boolean; failKeyActivity?: boolean; keyCalls?: string[]; usageBump?: number; byokDaily?: number; emptyActivity?: boolean; gate?: Promise<void>; networkDown?: boolean } = {}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    const path = url.pathname.replace('/api/v1', '')
    if (opts.networkDown) throw new TypeError('fetch failed')
    if (opts.fail) return new Response('{}', { status: 401 })
    if (opts.gate && path === '/credits') await opts.gate
    const hash = url.searchParams.get('api_key_hash')
    if (path === '/activity' && hash) {
      opts.keyCalls?.push(hash)
      if (opts.failKeyActivity) return new Response('{}', { status: 500 })
    }
    const body =
      path === '/key'
        ? { data: { ...(fixture('key-mgmt') as { data: object }).data, is_management_key: opts.managementKey ?? true } }
        : path === '/credits'
          ? fixture('credits')
          : path === '/keys'
            ? recentKeys(opts.usageBump, opts.byokDaily)
            : path === '/activity'
              ? opts.emptyActivity
                ? { data: [] }
                : recentActivity()
              : null
    return new Response(JSON.stringify(body), { status: body ? 200 : 404 })
  }) as typeof fetch
}

async function withFetch<T>(f: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = f
  try {
    return await run()
  } finally {
    globalThis.fetch = original
  }
}

// A worker that already holds a key, refreshed once against the fixtures.
async function connected(settings: Partial<Settings> = {}) {
  const host = mockHost({ secrets: { mgmtKey: MGMT }, settings })
  const worker = await mountWorker(main, { host })
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  return { host, worker }
}

const lastBar = (host: ReturnType<typeof mockHost>) =>
  host.callsOf('statusBar.update').at(-1) as { text?: string; tone?: string; visible?: boolean; tooltip?: string }

test('is unconfigured until a key is saved, and has no report', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  const status = (await worker.request('status.get')) as Status
  assert.equal(status.configured, false)
  assert.equal(status.keyLabel, null)
  assert.equal(await worker.request('report.get', QUERY), null)
})

test('rejects a key that is not a management key and stores nothing', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const res = await withFetch(fakeFetch({ managementKey: false }), () => worker.request('keys.save', { mgmtKey: MGMT }))
  assert.deepEqual(res, {
    ok: false,
    error: 'That key is not a management key. Create one under OpenRouter Settings → Management Keys.',
  })
  assert.deepEqual(host.data().secrets, {})
})

test('saves the key, remembers its masked label, and serves a report without total credits', async () => {
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  const res = await withFetch(fakeFetch(), () => worker.request('keys.save', { mgmtKey: MGMT }))
  assert.equal((res as { ok: boolean }).ok, true)
  assert.equal(host.data().secrets.mgmtKey, MGMT)
  const status = (await worker.request('status.get')) as Status
  assert.equal(status.configured, true)
  assert.equal(status.keyLabel, 'sk-or-v1-abc...xyz')
  const report = (await worker.request('report.get', QUERY)) as Report
  assert.ok(report.balance.remaining > 25 && report.balance.remaining < 26)
  assert.ok(!('totalCredits' in report.balance) && !('totalUsage' in report.balance))
  assert.ok(report.daily.length > 0)
  assert.ok(report.models[0].series.length > 0)
  assert.ok(lastBar(host).text?.includes('left'))
  // The key lives only in secrets, and the total never reaches the status bar.
  assert.ok(!JSON.stringify(host.data().storage).includes(MGMT))
  assert.ok(!JSON.stringify(worker.posts).includes(MGMT))
  assert.ok(!(lastBar(host).tooltip ?? '').includes('100')) // the total credits never appear
})

test('a refresh fills in the key label when none was stored', async () => {
  const { worker } = await connected()
  const status = (await worker.request('status.get')) as Status
  assert.equal(status.keyLabel, 'sk-or-v1-abc...xyz')
})

test('connection.test re-verifies the stored key', async () => {
  const { worker } = await connected()
  const ok = await withFetch(fakeFetch(), () => worker.request('connection.test'))
  assert.equal((ok as { ok: boolean }).ok, true)
  const bad = await withFetch(fakeFetch({ fail: true }), () => worker.request('connection.test'))
  assert.equal((bad as { ok: boolean }).ok, false)
  const none = await (await mountWorker(main, { host: mockHost() })).request('connection.test')
  assert.equal((none as { ok: boolean }).ok, false)
})

test('a failed refresh keeps the cached report and marks it stale', async () => {
  const { worker } = await connected()
  const failed = await withFetch(fakeFetch({ fail: true }), () => worker.request('refresh'))
  assert.equal((failed as { ok: boolean }).ok, false)
  const report = (await worker.request('report.get', { range: '7d', measure: 'tokens' })) as Report
  assert.ok(report.stale?.error.includes('rejected this key'), JSON.stringify(report.stale))
})

test('settings.set clamps values, persists them, and settings.get reads them back', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  const out = (await worker.request('settings.set', {
    refreshMinutes: 9999,
    lowBalanceUsd: -3,
    dailyBudgetUsd: 12.5,
    notifications: false,
  })) as Settings
  assert.equal(out.refreshMinutes, 120)
  assert.equal(out.lowBalanceUsd, 0)
  assert.equal(out.dailyBudgetUsd, 12.5)
  assert.equal(out.notifications, false)
  assert.deepEqual(await worker.request('settings.get'), out)
})

test('includeByok setting changes the spend in the report', async () => {
  const { worker } = await connected()
  const on = (await worker.request('report.get', QUERY)) as Report
  await worker.request('settings.set', { includeByok: false })
  const off = (await worker.request('report.get', QUERY)) as Report
  assert.ok(off.tiles.spend <= on.tiles.spend)
})

test('low-balance alert fires once, not on every refresh, and re-arms when settings change', async () => {
  const { host, worker } = await connected({ lowBalanceUsd: 30 })
  assert.equal(host.callsOf('notifications.show').length, 1)
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  assert.equal(host.callsOf('notifications.show').length, 1)
  await worker.request('settings.set', { lowBalanceUsd: 31 })
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  assert.equal(host.callsOf('notifications.show').length, 2)
})

test('no notification above the threshold, or with notifications off', async () => {
  const quiet = await connected({ lowBalanceUsd: 5 })
  assert.equal(quiet.host.callsOf('notifications.show').length, 0)
  const off = await connected({ lowBalanceUsd: 30, notifications: false })
  assert.equal(off.host.callsOf('notifications.show').length, 0)
})

test('daily budget alert fires once per day', async () => {
  const { host, worker } = await connected({ lowBalanceUsd: 0, dailyBudgetUsd: 0.001 })
  const budgetAlerts = () =>
    host.callsOf('notifications.show').filter((c) => String((c as { title: string }).title).includes('budget')).length
  assert.equal(budgetAlerts(), 1)
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  assert.equal(budgetAlerts(), 1)
})

test('status bar tone follows the low-balance threshold, and hides when turned off', async () => {
  assert.equal(lastBar((await connected({ lowBalanceUsd: 5 })).host).tone, 'neutral')
  assert.equal(lastBar((await connected({ lowBalanceUsd: 40 })).host).tone, 'warning')
  assert.equal(lastBar((await connected({ lowBalanceUsd: 60 })).host).tone, 'danger')
  const { host, worker } = await connected()
  await worker.request('settings.set', { statusBar: false })
  assert.equal(lastBar(host).visible, false)
})

test('keys.clear wipes keys, label and cached data', async () => {
  const { host, worker } = await connected()
  assert.deepEqual(await worker.request('keys.clear'), { ok: true })
  assert.deepEqual(host.data().secrets, {})
  assert.deepEqual(host.data().storage, {})
})

test('per-key activity is fetched for recently used keys, and only again when usage or the day changes', async () => {
  const calls: string[] = []
  const host = mockHost({ secrets: { mgmtKey: MGMT } })
  const worker = await mountWorker(main, { host })
  await withFetch(fakeFetch({ keyCalls: calls }), () => worker.request('refresh'))
  assert.equal(calls.length, 2) // only the two recently used keys
  const report = (await worker.request('report.get', QUERY)) as Report
  assert.ok(report.keys.filter((k) => k.spend !== null && k.spend > 0).length >= 1)
  await withFetch(fakeFetch({ keyCalls: calls }), () => worker.request('refresh'))
  assert.equal(calls.length, 2) // unchanged usage, same day: no refetch
  await withFetch(fakeFetch({ keyCalls: calls, usageBump: 1 }), () => worker.request('refresh'))
  assert.equal(calls.length, 4) // usage changed: both refetched
})

test('a failing per-key request does not fail the refresh', async () => {
  const host = mockHost({ secrets: { mgmtKey: MGMT } })
  const worker = await mountWorker(main, { host })
  const res = await withFetch(fakeFetch({ failKeyActivity: true }), () => worker.request('refresh'))
  assert.deepEqual(res, { ok: true })
  const report = (await worker.request('report.get', { range: '30d', measure: 'cost' })) as Report
  assert.ok(report.keys.some((k) => k.spend === null))
})

test('a rejected key turns the status bar red, and recovers on the next good refresh', async () => {
  const { host, worker } = await connected()
  await withFetch(fakeFetch({ fail: true }), () => worker.request('refresh'))
  assert.equal(lastBar(host).text, 'OpenRouter: key rejected')
  assert.equal(lastBar(host).tone, 'danger')
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  assert.ok(lastBar(host).text?.includes('left'))
})

test('status bar content follows the setting', async () => {
  const credits = await connected({ statusBarContent: 'credits' })
  assert.ok(/^\$[\d.]+ left$/.test(lastBar(credits.host).text ?? ''), lastBar(credits.host).text)
  const today = await connected({ statusBarContent: 'credits-today' })
  assert.ok(lastBar(today.host).text?.includes('today'))
  const days = await connected({ statusBarContent: 'credits-days' })
  assert.ok(/left · ~\d+d left$/.test(lastBar(days.host).text ?? ''), lastBar(days.host).text)
  const out = (await days.worker.request('settings.set', { statusBarContent: 'nonsense' as never })) as Settings
  assert.equal(out.statusBarContent, 'credits-days') // invalid values are ignored
})

test('BYOK daily totals reach the report, status bar and daily budget alert', async () => {
  const { host, worker } = await connected({ dailyBudgetUsd: 2, includeByok: true })
  await withFetch(fakeFetch({ byokDaily: 3 }), () => worker.request('refresh'))
  const on = (await worker.request('report.get', QUERY)) as Report
  assert.ok(on.tiles.today >= 3)
  assert.ok(lastBar(host).text?.includes(`$${on.tiles.today.toFixed(2)} today`))
  assert.equal(host.callsOf('notifications.show').filter((n) => (n as { title: string }).title.includes('daily budget')).length, 1)
  await worker.request('settings.set', { includeByok: false })
  const off = (await worker.request('report.get', QUERY)) as Report
  assert.ok(Math.abs(on.tiles.today - off.tiles.today - 3) < 1e-9)
})

test('old stored history is pruned on refresh', async () => {
  const old = { date: '2020-01-01', model: 'm', endpoint: 'e', usage: 1, byokUsage: 0, requests: 1, prompt: 1, completion: 1, reasoning: 0, cached: 0 }
  const host = mockHost({ secrets: { mgmtKey: MGMT }, storage: { rows: [old] } })
  const worker = await mountWorker(main, { host })
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  const rows = host.data().storage.rows as { date: string }[]
  assert.ok(rows.length > 0 && rows.every((r) => r.date > '2020-01-01'))
})

test('two quick settings changes both apply, and a non-threshold change does not re-arm alerts', async () => {
  const { host, worker } = await connected({ lowBalanceUsd: 30 })
  assert.equal(host.callsOf('notifications.show').length, 1)
  const [a, b] = (await Promise.all([
    worker.request('settings.set', { notifications: false }),
    worker.request('settings.set', { statusBar: false }),
  ])) as Settings[]
  assert.equal(a.notifications, false)
  assert.equal(b.statusBar, false)
  const final = (await worker.request('settings.get')) as Settings
  assert.equal(final.notifications, false) // neither write clobbered the other
  assert.equal(final.statusBar, false)
  await worker.request('settings.set', { includeByok: false }) // not a threshold
  await worker.request('settings.set', { notifications: true })
  await withFetch(fakeFetch(), () => worker.request('refresh'))
  assert.equal(host.callsOf('notifications.show').length, 1) // still the one from before
})

test('only the changed settings are written', async () => {
  const { host, worker } = await connected()
  const before = host.callsOf('settings.set').length
  await worker.request('settings.set', { dailyBudgetUsd: 7 })
  assert.equal(host.callsOf('settings.set').length - before, 1)
})

test('replacing the key with another account\'s key discards the old account\'s data', async () => {
  const { host, worker } = await connected()
  assert.ok((host.data().storage.rows as unknown[]).length > 0)
  await withFetch(fakeFetch({ emptyActivity: true }), () => worker.request('keys.save', { mgmtKey: 'sk-or-v1-another-account-key' }))
  assert.deepEqual(host.data().storage.rows, []) // no leftovers from the first account
  assert.equal(host.data().secrets.mgmtKey, 'sk-or-v1-another-account-key')
})

test('a refresh still running when the key is cleared cannot bring the data back', async () => {
  const host = mockHost({ secrets: { mgmtKey: MGMT } })
  const worker = await mountWorker(main, { host })
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => (release = r))
  await withFetch(fakeFetch({ gate }), async () => {
    const slow = worker.request('refresh') // blocked on /credits
    await worker.request('keys.clear')
    release()
    await slow
  })
  assert.deepEqual(host.data().secrets, {})
  assert.deepEqual(host.data().storage, {})
})

test('a notification that fails does not turn a good refresh into a failed one', async () => {
  const host = mockHost({
    secrets: { mgmtKey: MGMT },
    settings: { lowBalanceUsd: 30 },
    capabilities: ['storage:own', 'secrets:own', 'settings:own'], // notifications:show is missing
  })
  const worker = await mountWorker(main, { host })
  assert.deepEqual(await withFetch(fakeFetch(), () => worker.request('refresh')), { ok: true })
  const status = (await worker.request('status.get')) as Status
  assert.equal(status.lastError, null)
  assert.ok(status.lastRefreshAt !== null)
  assert.equal((host.data().storage.alerts as { lowFired: boolean }).lowFired, true) // saved, so no retry spam
})

test('the status bar says so when the first refresh could not reach OpenRouter', async () => {
  const host = mockHost({ secrets: { mgmtKey: MGMT } })
  const worker = await mountWorker(main, { host })
  await withFetch(fakeFetch({ networkDown: true }), () => worker.request('refresh'))
  assert.equal(lastBar(host).text, 'OpenRouter: unavailable')
  assert.equal(lastBar(host).tone, 'warning')
})
