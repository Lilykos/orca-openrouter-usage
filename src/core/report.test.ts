import { test, assert } from 'orca/testing'
// @ts-ignore node typings are not shipped with Orca's test kit
import { readFileSync } from 'node:fs'
import type { DayRow } from '../protocol'
import {
  buildReport,
  filterRows,
  normalizeActivity,
  normalizeKeys,
  rowCost,
} from './report'

const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../tests/fixtures/${name}`, import.meta.url), 'utf8'))

const NOW = Date.parse('2026-11-10T12:00:00Z')
const TODAY = '2026-11-10'

const rawActivity: any[] = load('activity.json').data
const rows = normalizeActivity(rawActivity)
const keys = normalizeKeys(load('keys.json').data)
const credits = { totalCredits: load('credits.json').data.total_credits, totalUsage: load('credits.json').data.total_usage }
const snapshots: { t: number; totalUsage: number; totalCredits: number }[] = []

const row = (over: Partial<DayRow> = {}): DayRow => ({
  date: '2026-11-05',
  model: 'm/a',
  endpoint: 'e1',
  usage: 1,
  byokUsage: 0,
  requests: 1,
  prompt: 100,
  completion: 10,
  reasoning: 0,
  cached: 50,
  ...over,
})

const baseInput = (over: Partial<Parameters<typeof buildReport>[0]> = {}) => ({
  rows,
  keys,
  keyRows: {} as Record<string, DayRow[]>,
  credits,
  snapshots,
  now: NOW,
  range: 'all' as const,
  measure: 'cost' as const,
  includeByok: false,
  stale: null,
  ...over,
})

test('normalizeActivity maps API fields to DayRow', () => {
  const r = rows[0]
  assert.equal(r.date, '2026-11-09')
  assert.equal(r.model, 'deepseek/deepseek-v4.1-flash-1017')
  assert.equal(r.endpoint, rawActivity[0].endpoint_id)
  assert.equal(r.usage, rawActivity[0].usage)
  assert.equal(r.byokUsage, rawActivity[0].byok_usage_inference)
  assert.equal(r.requests, rawActivity[0].requests)
  assert.equal(r.prompt, rawActivity[0].prompt_tokens)
  assert.equal(r.completion, rawActivity[0].completion_tokens)
  assert.equal(r.reasoning, rawActivity[0].reasoning_tokens)
  assert.equal(r.cached, rawActivity[0].cached_tokens)
  assert.equal(rows.length, rawActivity.length)
})

test('normalizeActivity tolerates missing fields', () => {
  const [r] = normalizeActivity([{ date: '2026-11-01 00:00:00' }])
  assert.deepEqual(
    { ...r },
    { date: '2026-11-01', model: '', endpoint: '', usage: 0, byokUsage: 0, requests: 0, prompt: 0, completion: 0, reasoning: 0, cached: 0 },
  )
})

test('normalizeKeys maps to camelCase with nulls for absent values', () => {
  const k = keys[0]
  assert.equal(k.hash, load('keys.json').data[0].hash)
  assert.equal(k.limit, null)
  assert.equal(k.limitRemaining, null)
  assert.equal(k.lastUsedAt, null)
  assert.equal(k.usageDaily, 0)
  assert.equal(typeof keys[2].usage, 'number')
  assert.ok(keys[2].usage > 0)
})

test('7d keeps only the 7 completed days before today', () => {
  const out = filterRows(rows, '7d', NOW)
  assert.ok(out.length > 0)
  for (const r of out) {
    assert.ok(r.date >= '2026-11-03' && r.date < TODAY, r.date)
  }
})

test('30d and all widen the window', () => {
  const d7 = filterRows(rows, '7d', NOW).length
  const d30 = filterRows(rows, '30d', NOW)
  const all = filterRows(rows, 'all', NOW)
  assert.ok(d7 <= d30.length)
  assert.ok(d30.length <= all.length)
  for (const r of d30) assert.ok(r.date >= '2026-10-11')
  assert.equal(all.length, rows.length)
})

test('today never appears in rows, even if present in input', () => {
  const extra = [...rows, row({ date: TODAY })]
  for (const range of ['7d', '30d', 'all'] as const) {
    assert.ok(filterRows(extra, range, NOW).every((r) => r.date !== TODAY))
  }
})

test('byok toggle changes cost, not row count', () => {
  const r = row({ usage: 2, byokUsage: 3 })
  assert.equal(rowCost(r, false), 2)
  assert.equal(rowCost(r, true), 5)

  const data = [r]
  const off = buildReport(baseInput({ rows: data, includeByok: false }))
  const on = buildReport(baseInput({ rows: data, includeByok: true }))
  assert.equal(off.tiles.spend, 2)
  assert.equal(on.tiles.spend, 5)
  assert.equal(off.models[0].requests, 1)
  assert.equal(on.models[0].requests, 1)
})

test('daily bars are zero-filled for missing days', () => {
  const report = buildReport(baseInput())
  const stored = new Set(rows.map((r) => r.date))
  const bars = report.daily.filter((b) => !b.partial)
  assert.equal(bars[0].date, '2026-10-17')
  assert.equal(bars[bars.length - 1].date, '2026-11-09')
  assert.equal(bars.length, report.historyDays)
  const gap = bars.find((b) => !stored.has(b.date))
  assert.ok(gap, 'fixture has at least one gap day')
  assert.equal(gap!.total, 0)
  assert.ok(bars.every((b) => Object.values(b.byModel).every((v) => v >= 0)))
})

test('byModel keeps top 5 models plus other, summing to total', () => {
  const report = buildReport(baseInput())
  const keyNames = Object.keys(report.daily[0].byModel)
  assert.equal(keyNames.length, 6)
  assert.ok(keyNames.includes('other'))
  for (const b of report.daily.filter((x) => !x.partial)) {
    const sum = Object.values(b.byModel).reduce((s, v) => s + v, 0)
    assert.ok(Math.abs(sum - b.total) < 1e-9, b.date)
  }
})

test('partial today bar only for cost measure', () => {
  const cost = buildReport(baseInput({ measure: 'cost' }))
  const last = cost.daily[cost.daily.length - 1]
  assert.equal(last.date, TODAY)
  assert.equal(last.partial, true)
  assert.equal(last.total, cost.tiles.today)
  assert.deepEqual(last.byModel, { other: cost.tiles.today })

  const tokens = buildReport(baseInput({ measure: 'tokens' }))
  assert.ok(tokens.daily.every((b) => !b.partial))
  assert.ok(tokens.daily.every((b) => b.date !== TODAY))
})

test('ranked lists sort by cost desc and costPerMTok is null without tokens', () => {
  const report = buildReport(baseInput({ range: '30d' }))
  assert.ok(report.models.length > 1)
  for (let i = 1; i < report.models.length; i++) {
    assert.ok(report.models[i - 1].cost >= report.models[i].cost)
  }
  const top = report.models[0]
  assert.equal(top.costPerMTok, top.cost / ((top.prompt + top.completion) / 1e6))

  const zero = buildReport(baseInput({ rows: [row({ prompt: 0, completion: 0 })] }))
  assert.equal(zero.models[0].costPerMTok, null)
})

test('empty rows: report does not throw and nullable fields are null', () => {
  const report = buildReport(baseInput({ rows: [], snapshots: [] }))
  assert.equal(report.tiles.cacheHitRate, null)
  assert.equal(report.tiles.avgCostPerRequest, null)
  assert.equal(report.balance.burnPerDay, null)
  assert.equal(report.balance.daysLeft, null)
  assert.equal(report.historyDays, 0)
  assert.deepEqual(report.heatmap, [])
  assert.deepEqual(report.models, [])
})

test('cache hit rate and average cost per request', () => {
  const report = buildReport(baseInput({ rows: [row({ prompt: 200, cached: 50, requests: 4, usage: 2 })] }))
  assert.equal(report.tiles.cacheHitRate, 0.25)
  assert.equal(report.tiles.avgCostPerRequest, 0.5)
  assert.equal(report.mix.cachedPrompt, 50)
  assert.equal(report.mix.uncachedPrompt, 150)
})

test('balance: remaining and burn over last 7 completed days', () => {
  const report = buildReport(baseInput())
  const from = '2026-11-03'
  const sum = rows.filter((r) => r.date >= from && r.date < TODAY).reduce((s, r) => s + r.usage, 0)
  const burn = sum / 7
  assert.ok(Math.abs(report.balance.remaining - (credits.totalCredits - credits.totalUsage)) < 1e-9)
  assert.ok(Math.abs(report.balance.burnPerDay! - burn) < 1e-9)
  assert.ok(Math.abs(report.balance.daysLeft! - report.balance.remaining / burn) < 1e-9)
})

test('balance: zero burn gives daysLeft null', () => {
  const old = [row({ date: '2026-10-01', usage: 5 })]
  const report = buildReport(baseInput({ rows: old }))
  assert.equal(report.balance.burnPerDay, 0)
  assert.equal(report.balance.daysLeft, null)
})

test('buildReport does not mutate its inputs', () => {
  const data = [row({ model: 'z' }), row({ model: 'y', date: '2026-11-04' })]
  const snapshot = JSON.stringify({ data, keys, credits })
  buildReport(baseInput({ rows: data }))
  assert.equal(JSON.stringify({ data, keys, credits }), snapshot)
})

const kinfo = (over: Partial<(typeof keys)[number]> = {}) => ({ ...keys[0], hash: 'k1', usage: 10, lastUsedAt: '2026-11-09T10:00:00Z', ...over })

test('key spend: lifetime for all, rolling sum of completed days for 7d/30d', () => {
  const keyRows = {
    k1: [
      row({ date: '2026-11-09', usage: 1 }), // inside 7d
      row({ date: '2026-11-02', usage: 2 }), // 8 days ago: 30d only
      row({ date: TODAY, usage: 100 }), // today is never counted
    ],
  }
  const spend = (range: 'all' | '7d' | '30d') =>
    buildReport(baseInput({ keys: [kinfo()], keyRows, range })).keys[0].spend
  assert.equal(spend('all'), 10)
  assert.equal(spend('7d'), 1)
  assert.equal(spend('30d'), 3)
})

test('key spend: null while a recently used key is unfetched, 0 for idle keys', () => {
  const recent = buildReport(baseInput({ keys: [kinfo()], range: '30d' })).keys[0]
  assert.equal(recent.spend, null)
  const idle = buildReport(baseInput({ keys: [kinfo({ lastUsedAt: '2026-07-01T00:00:00Z' })], range: '30d' })).keys[0]
  assert.equal(idle.spend, 0)
  const unused = buildReport(baseInput({ keys: [kinfo({ usage: 0, lastUsedAt: null })], range: '7d' })).keys[0]
  assert.equal(unused.spend, 0)
})

test('key spend honours the BYOK setting', () => {
  const keyRows = { k1: [row({ date: '2026-11-09', usage: 1, byokUsage: 4 })] }
  const spend = (includeByok: boolean) =>
    buildReport(baseInput({ keys: [kinfo()], keyRows, range: '7d', includeByok })).keys[0].spend
  assert.equal(spend(false), 1)
  assert.equal(spend(true), 5)
})

test('heatmap has one point for every day from the first stored day, idle days at zero', () => {
  const sparse = [
    row({ date: '2026-11-02', usage: 1 }),
    row({ date: '2026-11-05', usage: 2 }),
    row({ date: '2026-11-09', usage: 3 }),
  ]
  const { heatmap } = buildReport(baseInput({ rows: sparse, range: 'all' }))
  assert.deepEqual(
    heatmap.map((h) => h.date),
    ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'],
  )
  assert.deepEqual(heatmap.map((h) => h.cost), [1, 0, 0, 2, 0, 0, 0, 3])
  assert.deepEqual(buildReport(baseInput({ rows: [] })).heatmap, [])
})

test('models are ranked by the active measure, not always by cost', () => {
  const data = [
    row({ date: '2026-11-09', model: 'pricey', usage: 10, prompt: 100, completion: 0 }),
    row({ date: '2026-11-09', model: 'cheap-but-huge', usage: 1, prompt: 9000, completion: 0 }),
  ]
  const names = (measure: 'cost' | 'tokens') =>
    buildReport(baseInput({ rows: data, range: '7d', measure })).models.map((m) => m.name)
  assert.deepEqual(names('cost'), ['pricey', 'cheap-but-huge'])
  assert.deepEqual(names('tokens'), ['cheap-but-huge', 'pricey'])
})

test('this month: completed days of the month plus today, projected at the recent daily rate', () => {
  const data = [
    row({ date: '2026-10-31', usage: 100 }), // last month: never counted
    row({ date: '2026-11-01', usage: 1 }),
    row({ date: '2026-11-09', usage: 2 }), // inside the 7-day burn window: burn = 2 / 7
  ]
  const { tiles } = buildReport(baseInput({ rows: data, keys: [kinfo({ usageDaily: 0.5 })], range: '7d' }))
  assert.ok(Math.abs(tiles.monthToDate - 3.5) < 1e-9) // 1 + 2 + today's 0.5
  // 10 Nov of a 30-day month: 20 days left at 2/7 a day
  assert.ok(Math.abs(tiles.monthProjected! - (3.5 + (2 / 7) * 20)) < 1e-9)
})

test('this month ignores the selected range', () => {
  const data = [row({ date: '2026-11-01', usage: 4 })]
  const a = buildReport(baseInput({ rows: data, keys: [kinfo({ usageDaily: 0 })], range: '7d' })).tiles.monthToDate
  const b = buildReport(baseInput({ rows: data, keys: [kinfo({ usageDaily: 0 })], range: 'all' })).tiles.monthToDate
  assert.equal(a, 4)
  assert.equal(b, 4)
})

test('this month on the first day of a month starts from today only, in a 31-day month', () => {
  const now = Date.parse('2026-12-01T12:00:00Z')
  const data = [row({ date: '2026-11-30', usage: 7 })] // yesterday, but last month
  const { tiles } = buildReport(baseInput({ rows: data, keys: [kinfo({ usageDaily: 0.25 })], now }))
  assert.equal(tiles.monthToDate, 0.25)
  assert.ok(Math.abs(tiles.monthProjected! - (0.25 + (7 / 7) * 30)) < 1e-9) // 30 days left in December
})

test('this month: no history means no projection', () => {
  const { tiles } = buildReport(baseInput({ rows: [], keys: [kinfo({ usageDaily: 0.4 })] }))
  assert.equal(tiles.monthToDate, 0.4)
  assert.equal(tiles.monthProjected, null)
})

test('this month honours the BYOK setting', () => {
  const data = [row({ date: '2026-11-02', usage: 1, byokUsage: 4 })]
  const mtd = (includeByok: boolean) => buildReport(baseInput({ rows: data, keys: [kinfo({ usageDaily: 0 })], includeByok })).tiles.monthToDate
  assert.equal(mtd(false), 1)
  assert.equal(mtd(true), 5)
})

test('BYOK key totals follow the toggle for today, this month and lifetime keys', () => {
  const data = normalizeKeys([{ hash: 'byok', usage: 2, usage_daily: 1, byok_usage: 8, byok_usage_daily: 3 }])
  const report = (includeByok: boolean) => buildReport(baseInput({ rows: [], keys: data, includeByok }))
  assert.equal(report(false).tiles.today, 1)
  assert.equal(report(true).tiles.today, 4)
  assert.equal(report(true).tiles.monthToDate, 4)
  assert.equal(report(false).keys[0].spend, 2)
  assert.equal(report(true).keys[0].spend, 10)
})

test('BYOK changes the monthly projection but never the credit runway', () => {
  const data = [row({ date: '2026-11-09', usage: 7, byokUsage: 14 })]
  const off = buildReport(baseInput({ rows: data, keys: [], includeByok: false }))
  const on = buildReport(baseInput({ rows: data, keys: [], includeByok: true }))
  assert.equal(on.balance.burnPerDay, 1)
  assert.equal(on.balance.daysLeft, off.balance.daysLeft)
  assert.equal(on.tiles.monthProjected, 21 + 3 * 20)
})

test('a BYOK-only key can have recent activity', () => {
  const data = normalizeKeys([{ hash: 'byok', usage: 0, byok_usage: 3, last_used_at: '2026-11-09T12:00:00Z' }])
  const report = buildReport(baseInput({ rows: [], keys: data, range: '7d' }))
  assert.equal(report.keys[0].spend, null)
})

test('comparison uses equal completed UTC periods and includes per-model previous cost', () => {
  const data = [
    row({ date: '2026-10-27', usage: 8 }), // previous period starts exactly here
    row({ date: '2026-11-02', usage: 2 }),
    row({ date: '2026-11-03', usage: 3 }), // current period starts exactly here
    row({ date: '2026-11-09', usage: 2 }),
    row({ date: TODAY, usage: 100 }),
  ]
  const r = buildReport(baseInput({ rows: data, range: '7d' }))
  assert.deepEqual(r.comparison, { days: 7, current: 5, previous: 10, changePercent: -50 })
  assert.equal(r.models[0].previousCost, 10)
})

test('comparison needs two full periods and is unavailable for All', () => {
  assert.equal(buildReport(baseInput({ rows: [row()], range: '7d' })).comparison, null)
  assert.equal(buildReport(baseInput({ range: 'all' })).comparison, null)
  assert.equal(buildReport(baseInput({ range: '30d' })).comparison, null)
  const r = buildReport(baseInput({ range: '30d', rows: [row({ date: '2026-09-11', usage: 4 }), row({ date: '2026-10-11', usage: 8 })] }))
  assert.deepEqual(r.comparison, { days: 30, current: 8, previous: 4, changePercent: 100 })
})

test('comparison handles zero baselines, new models and BYOK without infinity', () => {
  const data = [row({ date: '2026-10-27', model: 'old', usage: 0 }), row({ usage: 2, byokUsage: 3 })]
  const r = buildReport(baseInput({ rows: data, range: '7d', includeByok: true }))
  assert.deepEqual(r.comparison, { days: 7, current: 5, previous: 0, changePercent: null })
  assert.equal(r.models.find((m) => m.name === 'm/a')!.previousCost, 0)
  const zero = buildReport(baseInput({ rows: [row({ date: '2026-10-27', usage: 0 })], range: '7d' }))
  assert.equal(zero.comparison!.changePercent, 0)
})

test('key health uses API remaining limit rather than lifetime usage and keeps reset and expiry metadata', () => {
  const data = normalizeKeys([{ hash: 'key', usage: 900, usage_daily: 9, limit: 10, limit_remaining: 1, limit_reset: 'daily', expires_at: '2026-11-12T12:00:00Z', include_byok_in_limit: true }])
  const key = buildReport(baseInput({ keys: data })).keys[0]
  assert.equal(key.limitReset, 'daily')
  assert.equal(key.includeByokInLimit, true)
  assert.equal(key.health.expiry, 'expiring')
  assert.equal(key.health.limit, 'near')
  assert.equal(key.health.usedFraction, 0.9)
})

test('key health handles expired keys, exhausted and zero limits, and invalid dates', () => {
  const data = normalizeKeys([
    { expires_at: '2026-11-10T12:00:00Z', limit: 10, limit_remaining: -1 },
    { expires_at: 'bad date', limit: 0 },
    { expires_at: '2026-11-18T12:00:00Z' },
  ])
  const out = buildReport(baseInput({ keys: data })).keys
  assert.equal(out[0].health.expiry, 'expired')
  assert.equal(out[0].health.limit, 'exhausted')
  assert.equal(out[0].health.usedFraction, 1)
  assert.equal(out[1].health.expiry, null)
  assert.equal(out[1].health.limit, 'exhausted')
  assert.equal(out[2].health.expiry, null)
  assert.equal(out[2].health.usedFraction, null)
})

test('key health falls back to the reset-period usage and the key limit BYOK policy', () => {
  const data = normalizeKeys([{ usage: 900, usage_monthly: 2, byok_usage_monthly: 7, limit: 10, limit_reset: 'monthly', include_byok_in_limit: true }])
  const on = buildReport(baseInput({ keys: data, includeByok: true })).keys[0]
  const off = buildReport(baseInput({ keys: data, includeByok: false })).keys[0]
  assert.equal(on.health.usedFraction, 0.9)
  assert.equal(off.health.usedFraction, 0.9) // spend toggle does not change the API key's limit policy
})
