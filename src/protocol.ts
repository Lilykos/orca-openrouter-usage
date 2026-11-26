// The contract between panel/index.html, src/worker.ts and src/core/*. Pure types, no runtime.
// Money is USD. Dates are 'YYYY-MM-DD' (UTC). Tokens and counts are integers.

export type Range = '7d' | '30d' | 'all'
export type Measure = 'cost' | 'tokens'
export type ExportKind = 'daily' | 'models' | 'keys'
export interface CsvExport { suggestedName: string; mimeType: string; data: string }

/** One /activity row, normalised. `date` is the first 10 chars of the API's date string. */
export interface DayRow {
  date: string
  model: string
  endpoint: string
  usage: number
  byokUsage: number
  requests: number
  prompt: number
  completion: number
  reasoning: number
  cached: number
}

export interface KeyInfo {
  hash: string
  name: string
  label: string
  disabled: boolean
  limit: number | null
  limitRemaining: number | null
  usage: number
  usageDaily: number
  usageWeekly: number
  usageMonthly: number
  /** Optional only for keys saved by versions before 1.1.0. */
  byokUsage?: number
  byokUsageDaily?: number
  byokUsageWeekly?: number
  byokUsageMonthly?: number
  limitReset?: 'daily' | 'weekly' | 'monthly' | null
  includeByokInLimit?: boolean
  expiresAt?: string | null
  lastUsedAt: string | null
}

/** A key as shown in the report: its totals plus its spend for the active range. */
export interface ReportKey extends KeyInfo {
  /** Spend in the range (USD): rolling completed days for 7d/30d, lifetime for 'all'; null while not yet fetched. */
  spend: number | null
  /** The same figure for every range, so the Keys view can switch range without a new report. */
  spendByRange: Record<Range, number | null>
  health: {
    expiry: 'expired' | 'expiring' | null
    limit: 'exhausted' | 'near' | null
    usedFraction: number | null
  }
}

export interface Balance {
  /** Credits left, USD. */
  remaining: number
  /** Mean daily credit spend over the last 7 completed UTC days; excludes external BYOK costs. */
  burnPerDay: number | null
  /** remaining / burnPerDay, or null when burn is 0 or unknown. */
  daysLeft: number | null
}

export interface Tiles {
  spend: number
  today: number
  tokensIn: number
  tokensOut: number
  reasoning: number
  requests: number
  /** spend / requests, or null when there are no requests. */
  avgCostPerRequest: number | null
  /** cached / prompt in 0..1, or null when there are no prompt tokens. */
  cacheHitRate: number | null
  /** Spend so far this UTC month: completed days from the stored history plus today's key totals. Ignores the range. */
  monthToDate: number
  /** monthToDate plus the recent daily burn for the rest of the month; null when there is no history to project from. */
  monthProjected: number | null
}

export interface TokenMix {
  cachedPrompt: number
  uncachedPrompt: number
  /** Completion tokens; reasoning tokens are counted inside them. */
  completion: number
  reasoning: number
}

export interface DailyBar {
  date: string
  /** Total for the active measure (cost or tokens). */
  total: number
  /** Every model used that day, by value in the active measure. Empty for today (no per-model data yet). */
  byModel: Record<string, number>
  /** That day's token mix. All zeros for today. */
  mix: TokenMix
  /** True for today: built from key totals, not /activity. */
  partial: boolean
}

export interface Ranked {
  name: string
  cost: number
  /** Cost in the preceding equal period; null without enough comparison history. */
  previousCost: number | null
  requests: number
  prompt: number
  completion: number
  reasoning: number
  cached: number
  /** cost per 1M (prompt + completion) tokens, or null. */
  costPerMTok: number | null
  /** Value in the active measure for each non-partial day in `Report.daily`, in order (for sparklines). */
  series: number[]
}

export interface Report {
  generatedAt: number
  range: Range
  measure: Measure
  balance: Balance
  tiles: Tiles
  monthlyBudgetUsd: number
  comparison: { days: number; current: number; previous: number; changePercent: number | null } | null
  daily: DailyBar[]
  models: Ranked[]
  keys: ReportKey[]
  /** Token mix for the range: cached prompt, uncached prompt, completion, reasoning. */
  mix: TokenMix
  /** Daily cost and tokens (prompt + completion) for the heatmap (all stored history, ignores range). */
  heatmap: { date: string; cost: number; tokens: number }[]
  /** Today's credit-balance snapshots for the intraday line: t = ms epoch, remaining = USD. */
  intraday: { t: number; remaining: number }[]
  /** Days of history we hold (from first stored day to yesterday). */
  historyDays: number
  /** Set when the last refresh failed; the report is then served from cache. */
  stale: { since: number; error: string } | null
}

export interface Status {
  configured: boolean
  /** OpenRouter's masked label for the stored management key (e.g. sk-or-v1-abc...xyz), or null. */
  keyLabel: string | null
  /** Set while a refresh is running. */
  refreshing: boolean
  lastRefreshAt: number | null
  lastError: string | null
}

export type StatusBarContent = 'credits' | 'credits-today' | 'credits-days'
export type BannerColor = 'purple' | 'gold' | 'teal' | 'rose' | 'graphite'

/** Options the person can change in the panel's settings view. Mirrors the manifest's `contributes.settings`. */
export interface Settings {
  refreshMinutes: number
  /** Notify and warn in the status bar when credits left drop below this (USD). 0 = off. */
  lowBalanceUsd: number
  /** Notify once per UTC day when today's spend passes this (USD). 0 = off. */
  dailyBudgetUsd: number
  /** Warn when actual or projected UTC-month spend exceeds this; 0 = off. */
  monthlyBudgetUsd: number
  /** Show desktop notifications for balance and budget alerts. */
  notifications: boolean
  /** Show the credits-left item in Orca's status bar. */
  statusBar: boolean
  /** What the status bar item says after the credits: nothing, today's spend, or the days left. */
  statusBarContent: StatusBarContent
  /** Count BYOK (bring your own key) usage in spend figures. */
  includeByok: boolean
  /** The credits banner's colour. */
  bannerColor: BannerColor
  /** A bold, saturated banner instead of the quiet gradient. */
  bannerVivid: boolean
}

declare module 'orca' {
  interface PluginRequests {
    'status.get': { output: Status }
    /** Verifies the management key against OpenRouter, then stores it and refreshes. */
    'keys.save': {
      input: { mgmtKey: string }
      output: { ok: true; label: string } | { ok: false; error: string }
    }
    /** Re-verifies the stored management key. */
    'connection.test': { output: { ok: true; label: string } | { ok: false; error: string } }
    'keys.clear': { output: { ok: true } }
    'settings.get': { output: Settings }
    /** Validates and stores the given fields (clamping numbers), answers the full settings. */
    'settings.set': { input: Partial<Settings>; output: Settings }
    'report.get': { input: { range: Range; measure: Measure }; output: Report | null }
    'export.csv': { input: { range: Range; kind: ExportKind }; output: CsvExport }
    'refresh': { output: { ok: true } | { ok: false; error: string } }
  }
  interface PluginPanelEvents {
    /** The worker finished a refresh; the panel should call report.get again. */
    'report.changed': { at: number }
    'status.changed': Status
  }
}
