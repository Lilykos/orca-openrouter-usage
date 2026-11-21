// Pure report builder: /activity rows and key totals in, the Report contract out. No I/O.
// All dates are UTC 'YYYY-MM-DD'. "Today" is the UTC date of `now`; rows are only ever completed days.

import type {
  Balance,
  DailyBar,
  DayRow,
  KeyInfo,
  Measure,
  Range,
  Ranked,
  Report,
  ReportKey,
  Tiles,
} from '../protocol'

export interface ReportInput {
  rows: DayRow[]
  keys: KeyInfo[]
  /** Per-key /activity rows keyed by key hash (completed days only). */
  keyRows: Record<string, DayRow[]>
  credits: { totalCredits: number; totalUsage: number }
  snapshots: { t: number; totalUsage: number; totalCredits: number }[]
  now: number
  range: Range
  measure: Measure
  includeByok: boolean
  monthlyBudgetUsd?: number
  stale: Report['stale']
}

const DAY_MS = 86_400_000
const TOP_MODELS = 5
const BURN_DAYS = 7

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const strOr = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)

const addDays = (day: string, n: number): string =>
  new Date(Date.parse(day + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10)

/** Completed days a range covers before today; null for 'all'. */
const rangeDays = (range: Range): number | null => (range === '7d' ? 7 : range === '30d' ? 30 : null)

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function normalizeActivity(apiRows: any[]): DayRow[] {
  return (apiRows ?? []).map((r) => ({
    date: strOr(r?.date).slice(0, 10),
    model: strOr(r?.model, strOr(r?.model_permaslug)),
    endpoint: strOr(r?.endpoint_id),
    usage: num(r?.usage),
    byokUsage: num(r?.byok_usage_inference),
    requests: num(r?.requests),
    prompt: num(r?.prompt_tokens),
    completion: num(r?.completion_tokens),
    reasoning: num(r?.reasoning_tokens),
    cached: num(r?.cached_tokens),
  }))
}

export function normalizeKeys(apiKeys: any[]): KeyInfo[] {
  return (apiKeys ?? []).map((k) => ({
    hash: strOr(k?.hash),
    name: strOr(k?.name),
    label: strOr(k?.label),
    disabled: k?.disabled === true,
    limit: k?.limit == null ? null : num(k.limit),
    limitRemaining: k?.limit_remaining == null ? null : num(k.limit_remaining),
    usage: num(k?.usage),
    usageDaily: num(k?.usage_daily),
    usageWeekly: num(k?.usage_weekly),
    usageMonthly: num(k?.usage_monthly),
    byokUsage: num(k?.byok_usage),
    byokUsageDaily: num(k?.byok_usage_daily),
    byokUsageWeekly: num(k?.byok_usage_weekly),
    byokUsageMonthly: num(k?.byok_usage_monthly),
    limitReset: ['daily', 'weekly', 'monthly'].includes(k?.limit_reset) ? k.limit_reset : null,
    includeByokInLimit: k?.include_byok_in_limit === true,
    expiresAt: typeof k?.expires_at === 'string' && Number.isFinite(Date.parse(k.expires_at)) ? k.expires_at : null,
    lastUsedAt: typeof k?.last_used_at === 'string' ? k.last_used_at : null,
  }))
}

/** Cost of one row in USD; BYOK spend is included only when asked for. */
export function rowCost(row: DayRow, includeByok: boolean): number {
  return includeByok ? row.usage + row.byokUsage : row.usage
}

export function todaySpend(keys: KeyInfo[], includeByok: boolean): number {
  return keys.reduce((sum, k) => sum + k.usageDaily + (includeByok ? k.byokUsageDaily ?? 0 : 0), 0)
}

function keyHealth(k: KeyInfo, now: number): ReportKey['health'] {
  const expires = k.expiresAt ? Date.parse(k.expiresAt) : NaN
  const expiry = expires <= now ? 'expired' : expires <= now + 7 * DAY_MS ? 'expiring' : null
  if (k.limit === null) return { expiry, limit: null, usedFraction: null }
  const usage = k.limitReset === 'daily' ? k.usageDaily : k.limitReset === 'weekly' ? k.usageWeekly : k.limitReset === 'monthly' ? k.usageMonthly : k.usage
  const byok = k.limitReset === 'daily' ? k.byokUsageDaily : k.limitReset === 'weekly' ? k.byokUsageWeekly : k.limitReset === 'monthly' ? k.byokUsageMonthly : k.byokUsage
  const remaining = k.limitRemaining ?? k.limit - usage - (k.includeByokInLimit ? byok ?? 0 : 0)
  const usedFraction = k.limit > 0 ? Math.min(1, Math.max(0, 1 - remaining / k.limit)) : 1
  return { expiry, limit: k.limit === 0 || remaining <= 0 ? 'exhausted' : usedFraction >= 0.9 ? 'near' : null, usedFraction }
}

/** The active measure for one row: cost in USD, or prompt + completion tokens. */
function valueOf(row: DayRow, measure: Measure, includeByok: boolean): number {
  return measure === 'cost' ? rowCost(row, includeByok) : row.prompt + row.completion
}

/** Completed UTC days only (never today), limited to the range. */
export function filterRows(rows: DayRow[], range: Range, now: number): DayRow[] {
  const today = utcDay(now)
  const n = rangeDays(range)
  const from = n === null ? null : addDays(today, -n)
  return rows.filter(
    (r) =>
      !!r.date &&
      r.date < today &&
      (from === null || r.date >= from)
  )
}

function rank(rows: DayRow[], keyOf: (r: DayRow) => string, includeByok: boolean): Ranked[] {
  const groups = new Map<string, Ranked>()
  for (const r of rows) {
    const name = keyOf(r)
    let e = groups.get(name)
    if (!e) {
      e = { name, cost: 0, previousCost: null, requests: 0, prompt: 0, completion: 0, reasoning: 0, cached: 0, costPerMTok: null, series: [] }
      groups.set(name, e)
    }
    e.cost += rowCost(r, includeByok)
    e.requests += r.requests
    e.prompt += r.prompt
    e.completion += r.completion
    e.reasoning += r.reasoning
    e.cached += r.cached
  }
  const out = [...groups.values()]
  for (const e of out) {
    const mTokens = (e.prompt + e.completion) / 1e6
    e.costPerMTok = mTokens > 0 ? e.cost / mTokens : null
  }
  return out.sort((a, b) => b.cost - a.cost || byName(a.name, b.name))
}

/** True when a key could have spend in the last ~30 days, so its /activity is worth fetching. */
export function keyMayHaveRecentActivity(k: KeyInfo, now: number): boolean {
  return k.usage + (k.byokUsage ?? 0) > 0 && k.lastUsedAt !== null && Date.parse(k.lastUsedAt) >= now - 32 * DAY_MS
}

export function buildReport(input: ReportInput): Report {
  const { rows, keys, keyRows, credits, snapshots, now, range, measure, includeByok, stale } = input
  const today = utcDay(now)
  const yesterday = addDays(today, -1)
  const inc = includeByok
  const scoped = filterRows(rows, range, now)

  // Tiles: spend and token counts come from scoped rows; "today" comes from key totals only.
  let spend = 0
  let requests = 0
  let prompt = 0
  let completion = 0
  let reasoning = 0
  let cached = 0
  for (const r of scoped) {
    spend += rowCost(r, inc)
    requests += r.requests
    prompt += r.prompt
    completion += r.completion
    reasoning += r.reasoning
    cached += r.cached
  }
  const tiles: Omit<Tiles, 'monthToDate' | 'monthProjected'> = {
    spend,
    today: todaySpend(keys, inc),
    tokensIn: prompt,
    tokensOut: completion,
    reasoning,
    requests,
    avgCostPerRequest: requests > 0 ? spend / requests : null,
    cacheHitRate: prompt > 0 ? cached / prompt : null,
  }

  // Daily bars: one per completed UTC day in the range, zero-filled.
  const stored = rows.map((r) => r.date).filter((d) => !!d && d < today)
  const firstStored = stored.length > 0 ? stored.reduce((a, b) => (a < b ? a : b)) : null
  const n = rangeDays(range)
  const startDay = n !== null ? addDays(today, -n) : firstStored
  const days: string[] = []
  if (startDay !== null) for (let d = startDay; d <= yesterday; d = addDays(d, 1)) days.push(d)

  const totalsByModel = new Map<string, number>()
  for (const r of scoped) totalsByModel.set(r.model, (totalsByModel.get(r.model) ?? 0) + valueOf(r, measure, inc))
  const top = [...totalsByModel.entries()]
    .sort((a, b) => b[1] - a[1] || byName(a[0], b[0]))
    .slice(0, TOP_MODELS)
    .map((e) => e[0])
  const topSet = new Set(top)
  const hasOther = totalsByModel.size > TOP_MODELS
  const keyNames = hasOther ? [...top, 'other'] : top

  const bars = new Map<string, DailyBar>()
  for (const d of days) {
    bars.set(d, {
      date: d,
      total: 0,
      byModel: Object.fromEntries(keyNames.map((k) => [k, 0])),
      partial: false,
    })
  }
  for (const r of scoped) {
    const bar = bars.get(r.date)
    if (!bar) continue
    const v = valueOf(r, measure, inc)
    const key = topSet.has(r.model) ? r.model : 'other'
    bar.total += v
    bar.byModel[key] = (bar.byModel[key] ?? 0) + v
  }
  const daily: DailyBar[] = days.map((d) => bars.get(d)!)
  if (measure === 'cost') {
    daily.push({ date: today, total: tiles.today, byModel: { other: tiles.today }, partial: true })
  }

  // Token mix for the range.
  const mix = {
    cachedPrompt: cached,
    uncachedPrompt: Math.max(0, prompt - cached),
    completion,
    reasoning,
  }

  // Heatmap: daily cost over all completed history, ignoring range.
  const history = rows.filter((r) => !!r.date && r.date < today)
  const heat = new Map<string, number>()
  for (const r of history) heat.set(r.date, (heat.get(r.date) ?? 0) + rowCost(r, inc))
  // /activity has no rows for idle days, but the calendar places cells by position: fill every day.
  const heatmap: { date: string; cost: number }[] = []
  if (firstStored !== null) {
    for (let d = firstStored; d <= yesterday; d = addDays(d, 1)) heatmap.push({ date: d, cost: heat.get(d) ?? 0 })
  }

  // Intraday: today's credit-balance snapshots.
  const intraday = snapshots
    .filter((s) => utcDay(s.t) === today)
    .sort((a, b) => a.t - b.t)
    .map((s) => ({ t: s.t, remaining: s.totalCredits - s.totalUsage }))

  const historyDays =
    firstStored === null
      ? 0
      : Math.max(0, Math.round((Date.parse(yesterday + 'T00:00:00Z') - Date.parse(firstStored + 'T00:00:00Z')) / DAY_MS) + 1)

  const previousStart = n === null ? null : addDays(today, -2 * n)
  const canCompare = previousStart !== null && firstStored !== null && firstStored <= previousStart
  const previousRows = canCompare ? history.filter((r) => r.date >= previousStart! && r.date < startDay!) : []
  const previous = previousRows.reduce((sum, r) => sum + rowCost(r, inc), 0)
  const comparison = canCompare ? {
    days: n!, current: spend, previous,
    changePercent: previous > 0 ? (spend - previous) / previous * 100 : spend > 0 ? null : 0,
  } : null
  const previousModels = new Map(rank(previousRows, (r) => r.model, inc).map((m) => [m.name, m.cost]))

  // Balance: burn is the mean daily spend over the last 7 completed days, ignoring the range.
  const remaining = credits.totalCredits - credits.totalUsage
  let burnPerDay: number | null = null
  let recentSpendPerDay: number | null = null
  if (rows.length > 0) {
    const from = addDays(today, -BURN_DAYS)
    let sum = 0
    let spend = 0
    for (const r of history) if (r.date >= from) {
      sum += r.usage
      spend += rowCost(r, inc)
    }
    burnPerDay = sum / BURN_DAYS
    recentSpendPerDay = spend / BURN_DAYS
  }
  const balance: Balance = {
    remaining,
    burnPerDay,
    daysLeft: burnPerDay !== null && burnPerDay > 0 ? remaining / burnPerDay : null,
  }

  // Per-model daily series (completed days only) for the drawer sparkline.
  const perModelDay = new Map<string, Map<string, number>>()
  for (const r of scoped) {
    let m = perModelDay.get(r.model)
    if (!m) perModelDay.set(r.model, (m = new Map()))
    m.set(r.date, (m.get(r.date) ?? 0) + valueOf(r, measure, inc))
  }
  const measured = (e: Ranked): number => (measure === 'cost' ? e.cost : e.prompt + e.completion)
  const models = rank(scoped, (r) => r.model, inc)
    .map((e) => ({ ...e, previousCost: canCompare ? previousModels.get(e.name) ?? 0 : null, series: days.map((d) => perModelDay.get(e.name)?.get(d) ?? 0) }))
    .sort((a, b) => measured(b) - measured(a) || byName(a.name, b.name))

  // This month so far (UTC calendar month) and where it lands at the recent daily rate.
  const monthStart = today.slice(0, 8) + '01'
  let monthToDate = tiles.today
  for (const r of history) if (r.date >= monthStart) monthToDate += rowCost(r, inc)
  const dayOfMonth = Number(today.slice(8, 10))
  const daysInMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).getUTCDate()
  const monthProjected = recentSpendPerDay === null ? null : monthToDate + recentSpendPerDay * (daysInMonth - dayOfMonth)

  return {
    generatedAt: now,
    range,
    measure,
    balance,
    tiles: { ...tiles, monthToDate, monthProjected },
    monthlyBudgetUsd: input.monthlyBudgetUsd ?? 0,
    comparison,
    daily,
    models,
    keys: keys.map((k): ReportKey => {
      let spend: number | null
      if (range === 'all') spend = k.usage + (inc ? k.byokUsage ?? 0 : 0)
      else if (keyRows[k.hash]) spend = filterRows(keyRows[k.hash], range, now).reduce((s, r) => s + rowCost(r, inc), 0)
      else spend = keyMayHaveRecentActivity(k, now) ? null : 0
      return { ...k, spend, health: keyHealth(k, now) }
    }),
    mix,
    heatmap,
    intraday,
    historyDays,
    stale: stale ? { ...stale } : null,
  }
}
