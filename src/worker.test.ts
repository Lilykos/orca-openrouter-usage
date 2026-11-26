// Runs src/worker.ts over a mock host with OpenRouter faked at the fetch boundary.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
// @ts-ignore node typings are not shipped with Orca's test kit
import { readFileSync } from 'node:fs'
import * as main from './worker'
import type { DeepSeekView, Report, Settings, Status } from './protocol'

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../tests/fixtures/${name}.json`, import.meta.url), 'utf8'))

const MGMT = 'sk-or-v1-fake-management-key'
const QUERY = { range: '30d', measure: 'cost' } as const

// Fixture keys with the first two stamped as used just now (the real fixture dates age out).
function recentKeys(bump = 0, byokDaily = 0): unknown {
  const body = fixture('keys') as { data: { usage: number; last_used_at: string | null }[] }
  const data = body.data.map((k, i) => (i < 2 ? { ...k, usage: Math.max(k.usage, 1) + bump, byok_usage_daily: i === 0 ? byokDaily : 0, last_used_at: new Date(Date.now()).toISOString() } : { ...k, last_used_at: null }))
  return { data }
}

// Keep the fixture's newest completed day at yesterday, independent of the test run date.
function recentActivity(scale = 1): unknown {
  const body = fixture('activity') as { data: { date: string; usage: number; byok_usage_inference: number }[] }
  const latest = Math.max(...body.data.map((r) => Date.parse(r.date.slice(0, 10) + 'T00:00:00Z')))
  const yesterday = Date.parse(new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) + 'T00:00:00Z')
  return { data: body.data.map((r) => ({ ...r, usage: r.usage * scale, byok_usage_inference: r.byok_usage_inference * scale, date: new Date(Date.parse(r.date.slice(0, 10) + 'T00:00:00Z') + yesterday - latest).toISOString().slice(0, 10) })) }
}

// Routes by path; `managementKey: false` makes /key report a regular key, `fail` makes every call 401.
function fakeFetch(opts: { managementKey?: boolean; fail?: boolean; failKeyActivity?: boolean; keyCalls?: string[]; usageBump?: number; byokDaily?: number; activityScale?: number; emptyActivity?: boolean; gate?: Promise<void>; networkDown?: boolean } = {}): typeof fetch {
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
                : recentActivity(opts.activityScale)
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
  assert.ok(lastBar(host).text?.endsWith(' today'))
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
  assert.ok(lastBar(host).text?.endsWith(' today'))
})

test('banner colour and vivid default to purple and quiet, save valid choices and ignore others', async () => {
  const { worker } = await connected({})
  const get = async () => (await worker.request('settings.get')) as Settings
  assert.equal((await get()).bannerColor, 'purple')
  assert.equal((await get()).bannerVivid, false)
  const out = (await worker.request('settings.set', { bannerColor: 'gold', bannerVivid: true })) as Settings
  assert.equal(out.bannerColor, 'gold')
  assert.equal(out.bannerVivid, true)
  assert.equal(((await worker.request('settings.set', { bannerColor: 'neon' as never })) as Settings).bannerColor, 'gold')
  assert.equal((await get()).bannerColor, 'gold')
})

test('the status bar shows what was spent today, with each account in the tooltip', async () => {
  const { host, worker } = await connected()
  const report = (await worker.request('report.get', QUERY)) as Report
  const bar = lastBar(host)
  assert.equal(bar.text, `$${report.tiles.today.toFixed(2)} today`)
  assert.ok(bar.tooltip?.startsWith('OpenRouter: $'), bar.tooltip)
  assert.ok(/^OpenRouter: \$[\d.]+ left · \$[\d.]+ today$/.test(bar.tooltip ?? ''), bar.tooltip)
  assert.ok(!bar.tooltip?.includes('DeepSeek')) // no DeepSeek key, no DeepSeek part
  assert.ok(!bar.tooltip?.includes('\n')) // one line: Orca's tooltips do not break lines
})

test('BYOK daily totals reach the report, status bar and daily budget alert', async () => {
  const { host, worker } = await connected({ dailyBudgetUsd: 2, includeByok: true })
  await withFetch(fakeFetch({ byokDaily: 3 }), () => worker.request('refresh'))
  const on = (await worker.request('report.get', QUERY)) as Report
  assert.ok(on.tiles.today >= 3)
  assert.equal(lastBar(host).text, `$${on.tiles.today.toFixed(2)} today`)
  assert.equal(host.callsOf('notifications.show').filter((n) => (n as { title: string }).title.includes('daily budget')).length, 1)
  await worker.request('settings.set', { includeByok: false })
  const off = (await worker.request('report.get', QUERY)) as Report
  assert.ok(Math.abs(on.tiles.today - off.tiles.today - 3) < 1e-9)
})

test('CSV export follows the requested range and BYOK setting and contains no management key', async () => {
  const { worker } = await connected()
  const on = await worker.request('export.csv', { range: '7d', kind: 'daily' }) as { data: string; suggestedName: string }
  assert.ok(on.suggestedName.includes('daily-7d'))
  assert.ok(on.data.includes('"7d"'))
  assert.ok(!JSON.stringify(on).includes(MGMT))
  await worker.request('settings.set', { includeByok: false })
  const off = await worker.request('export.csv', { range: '7d', kind: 'daily' }) as { data: string }
  assert.notEqual(on.data, off.data)
  await assert.rejects(() => worker.request('export.csv', { range: 'bad', kind: 'daily' } as never), /Invalid export/)
  await assert.rejects(() => worker.request('export.csv', { range: '7d', kind: 'bad' } as never), /Invalid export/)
})

test('CSV export requires a report', async () => {
  const worker = await mountWorker(main, { host: mockHost() })
  await assert.rejects(() => worker.request('export.csv', { range: '7d', kind: 'daily' }), /No usage data/)
})

test('monthly budget is optional, validated and included in reports', async () => {
  const { worker } = await connected()
  assert.equal(((await worker.request('report.get', QUERY)) as Report).monthlyBudgetUsd, 0)
  await worker.request('settings.set', { monthlyBudgetUsd: 42.5 })
  assert.equal(((await worker.request('report.get', QUERY)) as Report).monthlyBudgetUsd, 42.5)
  await worker.request('settings.set', { monthlyBudgetUsd: -1 })
  assert.equal(((await worker.request('settings.get')) as Settings).monthlyBudgetUsd, 0)
})

test('monthly budget alerts on projection, deduplicates, recovers and respects notifications off', async () => {
  const original = Date.now
  Date.now = () => Date.parse('2026-11-10T12:00:00Z')
  try {
    const { host, worker } = await connected({ lowBalanceUsd: 0 })
    const refresh = () => withFetch(fakeFetch(), () => worker.request('refresh'))
    const alerts = () => host.callsOf('notifications.show').filter((c) => (c as { title: string }).title.includes('monthly budget'))
    const r = await worker.request('report.get', QUERY) as Report
    const limit = (r.tiles.monthToDate + r.tiles.monthProjected!) / 2
    assert.ok(r.tiles.monthToDate < limit && r.tiles.monthProjected! > limit)
    await worker.request('settings.set', { monthlyBudgetUsd: limit || 0.001 })
    await refresh()
    assert.equal(alerts().length, 1)
    await refresh()
    assert.equal(alerts().length, 1)
    await worker.request('settings.set', { monthlyBudgetUsd: 1_000_000 })
    await refresh()
    await worker.request('settings.set', { monthlyBudgetUsd: 0.001 })
    await refresh()
    assert.equal(alerts().length, 2)
    const quiet = await connected({ monthlyBudgetUsd: 0.001, notifications: false })
    assert.equal(quiet.host.callsOf('notifications.show').length, 0)
  } finally { Date.now = original }
})

test('monthly budget alert fires again in a new UTC month', async () => {
  const original = Date.now
  let now = Date.parse('2026-11-30T12:00:00Z')
  Date.now = () => now
  try {
    const { host, worker } = await connected({ monthlyBudgetUsd: 0.001, lowBalanceUsd: 0 })
    const alerts = () => host.callsOf('notifications.show').filter((c) => (c as { title: string }).title.includes('monthly budget'))
    assert.equal(alerts().length, 1)
    now = Date.parse('2026-12-01T00:01:00Z')
    await withFetch(fakeFetch(), () => worker.request('refresh'))
    assert.equal(alerts().length, 2)
  } finally { Date.now = original }
})

test('monthly forecast alerts re-arm after recovery without re-sending the low-balance alert', async () => {
  const { host, worker } = await connected({ lowBalanceUsd: 30 })
  await worker.request('settings.set', { monthlyBudgetUsd: 10 })
  const refresh = (activityScale: number) => withFetch(fakeFetch({ activityScale }), () => worker.request('refresh'))
  const monthly = () => host.callsOf('notifications.show').filter((c) => (c as { title: string }).title.includes('monthly budget')).length
  await refresh(100)
  assert.equal(monthly(), 1)
  await refresh(0)
  await refresh(100)
  assert.equal(monthly(), 2)
  assert.equal(host.callsOf('notifications.show').filter((c) => (c as { title: string }).title.includes('credits low')).length, 1)
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

// ---- the optional DeepSeek account ----

const DS = 'sk-deepseek-test-key-1234'
// OpenRouter from the fixtures, plus DeepSeek's balance endpoint with a settable total.
function withDeepSeek(state: { total: string; status?: number; calls?: number }): typeof fetch {
  const or = fakeFetch()
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.host === 'api.deepseek.com') {
      state.calls = (state.calls ?? 0) + 1
      if (state.status) return new Response('{}', { status: state.status })
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: state.total, granted_balance: '0.00', topped_up_balance: state.total }] }), { status: 200 })
    }
    return or(input, init)
  }) as typeof fetch
}

test('DeepSeek stays hidden until a key is saved', async () => {
  const { worker } = await connected()
  assert.equal(await worker.request('deepseek.get'), null)
})

test('a DeepSeek key is verified, stored as a secret and shown masked with its balance', async () => {
  const { host, worker } = await connected()
  const ds = { total: '12.50' }
  const res = await withFetch(withDeepSeek(ds), () => worker.request('deepseek.save', { apiKey: DS }))
  assert.deepEqual(res, { ok: true, label: 'sk-…1234' })
  assert.equal(host.data().secrets.deepseekKey, DS)
  assert.ok(!JSON.stringify(host.data().storage).includes(DS))
  const view = (await worker.request('deepseek.get')) as DeepSeekView
  assert.equal(view.label, 'sk-…1234')
  assert.equal(view.available, true)
  assert.equal(view.balances[0].total, 12.5)
  assert.equal(view.balances[0].burnPerDay, null) // one reading is not enough for a rate
})

test('a rejected DeepSeek key is not stored', async () => {
  const { host, worker } = await connected()
  const res = await withFetch(withDeepSeek({ total: '1', status: 401 }), () => worker.request('deepseek.save', { apiKey: DS }))
  assert.deepEqual(res, { ok: false, error: 'DeepSeek rejected this key. It may be mistyped or revoked.' })
  assert.equal(host.data().secrets.deepseekKey, undefined)
  assert.equal(await worker.request('deepseek.get'), null)
})

test('refreshes read the DeepSeek balance, and its failures do not fail the refresh', async () => {
  const { worker } = await connected()
  const ds = { total: '12.50', calls: 0 }
  await withFetch(withDeepSeek(ds), () => worker.request('deepseek.save', { apiKey: DS }))
  ds.total = '11.00'
  await withFetch(withDeepSeek(ds), () => worker.request('refresh'))
  assert.equal(((await worker.request('deepseek.get')) as DeepSeekView).balances[0].total, 11)
  const down = { total: '0', status: 503 }
  const res = await withFetch(withDeepSeek(down), () => worker.request('refresh'))
  assert.equal((res as { ok: boolean }).ok, true)
  const view = (await worker.request('deepseek.get')) as DeepSeekView
  assert.equal(view.balances[0].total, 11) // the last good reading stays
  assert.ok(view.error?.includes('DeepSeek had a problem'))
})

test('removing the DeepSeek key forgets the key and everything read with it', async () => {
  const { host, worker } = await connected()
  await withFetch(withDeepSeek({ total: '5' }), () => worker.request('deepseek.save', { apiKey: DS }))
  assert.deepEqual(await worker.request('deepseek.clear'), { ok: true })
  assert.equal(host.data().secrets.deepseekKey, undefined)
  assert.ok(!Object.keys(host.data().storage).some((k) => k.startsWith('ds')))
  assert.equal(await worker.request('deepseek.get'), null)
})

test('testing the DeepSeek connection re-reads the balance and reports failures', async () => {
  const { worker } = await connected()
  assert.deepEqual(await worker.request('deepseek.test'), { ok: false, error: 'No DeepSeek key saved.' })
  const ds = { total: '9.00' }
  await withFetch(withDeepSeek(ds), () => worker.request('deepseek.save', { apiKey: DS }))
  ds.total = '8.50'
  assert.deepEqual(await withFetch(withDeepSeek(ds), () => worker.request('deepseek.test')), { ok: true })
  assert.equal(((await worker.request('deepseek.get')) as DeepSeekView).balances[0].total, 8.5)
  const bad = await withFetch(withDeepSeek({ total: '1', status: 401 }), () => worker.request('deepseek.test'))
  assert.deepEqual(bad, { ok: false, error: 'DeepSeek rejected this key. It may be mistyped or revoked.' })
})

test('a DeepSeek key adds its line to the status bar tooltip and its dollars to today', async () => {
  const { host, worker } = await connected()
  await withFetch(withDeepSeek({ total: '12.50' }), () => worker.request('deepseek.save', { apiKey: DS }))
  await new Promise((r) => setTimeout(r, 20))
  const bar = lastBar(host)
  assert.ok(bar.tooltip?.split(' | ').some((l) => l.startsWith('DeepSeek: $12.50 left')), bar.tooltip)
  await worker.request('deepseek.clear')
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(!lastBar(host).tooltip?.includes('DeepSeek'))
})

