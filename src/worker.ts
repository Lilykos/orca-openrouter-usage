// The plugin's worker: owns the API keys, the network, the cache and the alerts. The panel only
// asks it for finished reports (src/protocol.ts) and never sees a key.
import type { OrcaWorkerApi } from 'orca/worker'
import type { BannerColor, DayRow, DeepSeekView, KeyInfo, Measure, Range, Report, Settings, Status, StatusBarContent } from './protocol'
import { OpenRouterError, createClient, getActivity, getCredits, getKeyActivity, getKeyMeta, listKeys } from './core/openrouter'
import { buildReport, keyMayHaveRecentActivity, normalizeActivity, normalizeKeys, todaySpend } from './core/report'
import { addSnapshot, mergeDays, pruneRows, type Snapshot } from './core/history'
import { addSnapshots, burnPerDay, describeDeepSeekError, getBalance, maskKey, DeepSeekError, type DeepSeekAccount, type DeepSeekSnapshot } from './core/deepseek'
import { reportCsv } from './core/csv'

const MGMT_KEY = 'mgmtKey'
const KEY_LABEL = 'keyLabel'
const DS_KEY = 'deepseekKey'
/** Storage for the optional DeepSeek account; all of it goes when its key is removed. */
const DS_STORE = ['dsLabel', 'dsCache', 'dsSnapshots', 'dsMeta']

interface Cache {
  credits: { totalCredits: number; totalUsage: number } | null
  keys: KeyInfo[]
}
interface Meta {
  lastRefreshAt: number | null
  lastError: string | null
  errorSince: number | null
  /** The last refresh failed because OpenRouter rejected the key (revoked, wrong kind). */
  authFailed?: boolean
}
interface Alerts {
  lowFired: boolean
  budgetFiredDate: string | null
  monthlyFiredMonth?: string | null
}

type RefreshResult = { ok: true } | { ok: false; error: string }

const EMPTY_CACHE: Cache = { credits: null, keys: [] }
const EMPTY_META: Meta = { lastRefreshAt: null, lastError: null, errorSince: null }
const EMPTY_ALERTS: Alerts = { lowFired: false, budgetFiredDate: null, monthlyFiredMonth: null }

const DEFAULT_SETTINGS: Settings = {
  refreshMinutes: 5,
  lowBalanceUsd: 5,
  dailyBudgetUsd: 0,
  monthlyBudgetUsd: 0,
  notifications: true,
  statusBar: true,
  statusBarContent: 'credits-today',
  includeByok: true,
  bannerColor: 'purple',
  bannerVivid: false,
}

const CONTENT_CHOICES: readonly StatusBarContent[] = ['credits', 'credits-today', 'credits-days']
const BANNER_COLORS: readonly BannerColor[] = ['purple', 'gold', 'teal', 'rose', 'graphite']

// Plain-English reasons for the failures a person can actually act on.
function describeError(e: unknown): string {
  if (!(e instanceof OpenRouterError)) return 'Something went wrong talking to OpenRouter.'
  switch (e.code) {
    case 'unauthorized':
      return 'OpenRouter rejected this key. It may be mistyped or revoked.'
    case 'forbidden':
      return "This key isn't allowed to read account data. Use a management key."
    case 'rate_limited':
      return 'OpenRouter is rate limiting requests. Try again in a minute.'
    case 'server':
      return 'OpenRouter had a problem on its side. Try again shortly.'
    case 'network':
      return "Can't reach OpenRouter. Check your internet connection."
    default:
      return 'OpenRouter sent an unexpected response.'
  }
}

const isAuthProblem = (e: unknown): boolean => e instanceof OpenRouterError && (e.code === 'unauthorized' || e.code === 'forbidden')

const clampNumber = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback

const usd = (n: number): string => `$${n.toFixed(2)}`
const utcDay = (t: number): string => new Date(t).toISOString().slice(0, 10)

export default function activate(orca: OrcaWorkerApi): void {
  // Background work nobody awaits: a rejection here would crash the worker, so log it instead.
  const detach = (p: Promise<unknown>): void => {
    p.catch((e) => orca.log(`background task failed: ${e instanceof Error ? e.message : 'error'}`))
  }

  let timer: ReturnType<typeof setInterval> | null = null

  async function load<T>(key: string, empty: T): Promise<T> {
    const value = await orca.storage.get(key)
    return value == null ? empty : (value as T)
  }

  async function status(): Promise<Status> {
    const meta = await load<Meta>('meta', EMPTY_META)
    return {
      configured: (await orca.secrets.get(MGMT_KEY)) !== null,
      keyLabel: await load<string | null>(KEY_LABEL, null),
      refreshing: refreshing !== null,
      lastRefreshAt: meta.lastRefreshAt,
      lastError: meta.lastError,
    }
  }

  async function postStatus(): Promise<void> {
    orca.panels.post('status.changed', await status())
  }

  async function readSettings(): Promise<Settings> {
    const raw = (await orca.settings.get()) as Record<string, unknown>
    const bool = (k: keyof Settings): boolean => (typeof raw[k] === 'boolean' ? (raw[k] as boolean) : (DEFAULT_SETTINGS[k] as boolean))
    return {
      refreshMinutes: Math.round(clampNumber(raw.refreshMinutes, 1, 120, DEFAULT_SETTINGS.refreshMinutes)),
      lowBalanceUsd: clampNumber(raw.lowBalanceUsd, 0, 1_000_000, DEFAULT_SETTINGS.lowBalanceUsd),
      dailyBudgetUsd: clampNumber(raw.dailyBudgetUsd, 0, 1_000_000, DEFAULT_SETTINGS.dailyBudgetUsd),
      monthlyBudgetUsd: clampNumber(raw.monthlyBudgetUsd, 0, 1_000_000, DEFAULT_SETTINGS.monthlyBudgetUsd),
      notifications: bool('notifications'),
      statusBar: bool('statusBar'),
      statusBarContent: CONTENT_CHOICES.includes(raw.statusBarContent as StatusBarContent)
        ? (raw.statusBarContent as StatusBarContent)
        : DEFAULT_SETTINGS.statusBarContent,
      includeByok: bool('includeByok'),
      bannerColor: BANNER_COLORS.includes(raw.bannerColor as BannerColor) ? (raw.bannerColor as BannerColor) : DEFAULT_SETTINGS.bannerColor,
      bannerVivid: bool('bannerVivid'),
    }
  }

  async function updateStatusBar(): Promise<void> {
    const settings = await readSettings()
    if (!settings.statusBar) {
      await orca.host.call('statusBar.update', { id: 'balance', visible: false })
      return
    }
    const cache = await load<Cache>('cache', EMPTY_CACHE)
    if (!(await orca.secrets.get(MGMT_KEY))) {
      await orca.host.call('statusBar.update', { id: 'balance', text: 'OpenRouter: set up', tone: 'neutral', visible: true })
      return
    }
    const meta = await load<Meta>('meta', EMPTY_META)
    if (meta.authFailed) {
      await orca.host.call('statusBar.update', {
        id: 'balance',
        text: 'OpenRouter: key rejected',
        tone: 'danger',
        tooltip: 'OpenRouter rejected the stored key. Open the OpenRouter Usage panel, Settings tab, to replace it.',
        visible: true,
      })
      return
    }
    if (!cache.credits) {
      await orca.host.call('statusBar.update', {
        id: 'balance',
        text: meta.lastError ? 'OpenRouter: unavailable' : 'OpenRouter: loading…',
        tone: meta.lastError ? 'warning' : 'neutral',
        tooltip: meta.lastError ?? 'Fetching your OpenRouter usage',
        visible: true,
      })
      return
    }
    const remaining = cache.credits.totalCredits - cache.credits.totalUsage
    const today = todaySpend(cache.keys, settings.includeByok)
    const low = settings.lowBalanceUsd
    const tone = low > 0 && remaining <= low / 2 ? 'danger' : low > 0 && remaining <= low ? 'warning' : 'neutral'
    let extra = ''
    if (settings.statusBarContent === 'credits-today') extra = ` · ${usd(today)} today`
    else if (settings.statusBarContent === 'credits-days') {
      const days = (await currentReport('7d', 'cost'))?.balance.daysLeft
      if (days != null) extra = ` · ~${Math.round(days)}d left`
    }
    await orca.host.call('statusBar.update', {
      id: 'balance',
      text: `${usd(remaining)} left${extra}`,
      tone,
      tooltip: 'OpenRouter credits left',
      visible: true,
    })
  }

  // A failed notification is logged and treated as shown: retrying it on every poll would only spam.
  async function notify(params: { title: string; body: string }): Promise<void> {
    try {
      await orca.host.call('notifications.show', params)
    } catch (e) {
      orca.log(`notification failed: ${e instanceof Error ? e.message : 'error'}`)
    }
  }

  // One notification per threshold crossing, not one per poll.
  async function checkAlerts(): Promise<void> {
    const cache = await load<Cache>('cache', EMPTY_CACHE)
    if (!cache.credits) return
    const alerts = await load<Alerts>('alerts', EMPTY_ALERTS)
    const next = { ...alerts }
    const remaining = cache.credits.totalCredits - cache.credits.totalUsage
    const settings = await readSettings()
    const low = settings.lowBalanceUsd
    if (low > 0 && remaining < low) {
      if (!alerts.lowFired) {
        next.lowFired = true
        if (settings.notifications) await notify({
          title: 'OpenRouter credits low',
          body: `${usd(remaining)} left (alert threshold ${usd(low)}).`,
        })
      }
    } else {
      next.lowFired = false
    }
    const budget = settings.dailyBudgetUsd
    const today = todaySpend(cache.keys, settings.includeByok)
    const day = utcDay(Date.now())
    if (budget > 0 && today > budget && alerts.budgetFiredDate !== day) {
      next.budgetFiredDate = day
      if (settings.notifications) await notify({
        title: 'OpenRouter daily budget passed',
        body: `${usd(today)} spent today (budget ${usd(budget)}).`,
      })
    }
    const monthly = settings.monthlyBudgetUsd > 0 ? await currentReport('all', 'cost') : null
    const overMonthly = monthly && Math.max(monthly.tiles.monthToDate, monthly.tiles.monthProjected ?? 0) > settings.monthlyBudgetUsd
    if (overMonthly) {
      const month = day.slice(0, 7)
      if (alerts.monthlyFiredMonth !== month) {
        next.monthlyFiredMonth = month
        if (settings.notifications) await notify({
          title: 'OpenRouter monthly budget warning',
          body: `${usd(monthly.tiles.monthToDate)} spent this UTC month${monthly.tiles.monthProjected === null ? '' : `; projected ${usd(monthly.tiles.monthProjected)}`} (budget ${usd(settings.monthlyBudgetUsd)}).`,
        })
      }
    } else next.monthlyFiredMonth = null
    if (next.lowFired !== alerts.lowFired || next.budgetFiredDate !== alerts.budgetFiredDate || next.monthlyFiredMonth !== alerts.monthlyFiredMonth) {
      await orca.storage.set('alerts', next as never)
    }
  }

  // Per-key activity (for the Keys tab's 7d/30d). A key is refetched only when its usage changed or
  // the UTC day rolled over; failures keep the previous rows and never fail the refresh. Network only:
  // the caller stores the result once it knows the refresh is still current.
  async function fetchKeyRows(
    client: ReturnType<typeof createClient>,
    keys: KeyInfo[],
    now: number,
  ): Promise<{ rows: Record<string, DayRow[]>; fetched: Record<string, { usage: number; day: string }> }> {
    const day = utcDay(now)
    const rows = await load<Record<string, DayRow[]>>('keyRows', {})
    const fetched = await load<Record<string, { usage: number; day: string }>>('keyFetch', {})
    const live = new Set(keys.map((k) => k.hash))
    for (const h of Object.keys(rows)) if (!live.has(h)) delete rows[h]
    for (const h of Object.keys(fetched)) if (!live.has(h)) delete fetched[h]
    const due = keys.filter(
      (k) => keyMayHaveRecentActivity(k, now) && (fetched[k.hash]?.usage !== k.usage + (k.byokUsage ?? 0) || fetched[k.hash]?.day !== day),
    )
    for (let i = 0; i < due.length; i += 3) {
      await Promise.all(
        due.slice(i, i + 3).map(async (k) => {
          try {
            rows[k.hash] = pruneRows(mergeDays(rows[k.hash] ?? [], normalizeActivity(await getKeyActivity(client, k.hash))), now)
            fetched[k.hash] = { usage: k.usage + (k.byokUsage ?? 0), day }
          } catch (e) {
            orca.log(`key activity failed: ${e instanceof OpenRouterError ? e.code : 'error'}`)
          }
        }),
      )
    }
    return { rows, fetched }
  }

  async function currentReport(range: Range, measure: Measure, settings?: Settings): Promise<Report | null> {
    const cache = await load<Cache>('cache', EMPTY_CACHE)
    if (!cache.credits) return null
    const meta = await load<Meta>('meta', EMPTY_META)
    settings ??= await readSettings()
    return buildReport({
      rows: await load<DayRow[]>('rows', []),
      keys: cache.keys,
      keyRows: await load<Record<string, DayRow[]>>('keyRows', {}),
      credits: cache.credits,
      snapshots: await load<Snapshot[]>('snapshots', []),
      now: Date.now(),
      range,
      measure,
      includeByok: settings.includeByok,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      stale: meta.lastError ? { since: meta.errorSince ?? Date.now(), error: meta.lastError } : null,
    })
  }

  // Bumped whenever the key is saved or cleared. A refresh that started under an older value is
  // discarded instead of written, so a swapped or removed key never gets the old account's data back.
  let epoch = 0
  const CACHE_KEYS = ['rows', 'snapshots', 'cache', 'meta', 'keyRows', 'keyFetch']

  async function wipeCaches(): Promise<void> {
    for (const k of CACHE_KEYS) await orca.storage.delete(k)
  }

  async function doRefresh(myEpoch: number): Promise<RefreshResult> {
    const key = await orca.secrets.get(MGMT_KEY)
    if (!key) return { ok: false as const, error: 'No management key configured.' }
    const meta = await load<Meta>('meta', EMPTY_META)
    const superseded = (): boolean => epoch !== myEpoch
    const changedMsg: RefreshResult = { ok: false as const, error: 'The key changed during the refresh.' }
    let outcome: RefreshResult
    try {
      const client = createClient({ key })
      // /activity without a date returns all 30 completed days in one call.
      const [credits, rawKeys, rawRows] = await Promise.all([getCredits(client), listKeys(client), getActivity(client)])
      const now = Date.now()
      const keys = normalizeKeys(rawKeys)
      const keyData = await fetchKeyRows(client, keys, now)
      if (superseded()) return changedMsg
      const rows = pruneRows(mergeDays(await load<DayRow[]>('rows', []), normalizeActivity(rawRows)), now)
      const snapshots = addSnapshot(await load<Snapshot[]>('snapshots', []), {
        t: now,
        totalUsage: credits.totalUsage,
        totalCredits: credits.totalCredits,
      })
      await orca.storage.set('rows', rows as never)
      await orca.storage.set('snapshots', snapshots as never)
      await orca.storage.set('cache', { credits, keys } as never)
      await orca.storage.set('keyRows', keyData.rows as never)
      await orca.storage.set('keyFetch', keyData.fetched as never)
      await orca.storage.set('meta', { lastRefreshAt: now, lastError: null, errorSince: null, authFailed: false } as never)
      // The key changed while we were writing: take it all back rather than leave the old account's data.
      if (superseded()) {
        await wipeCaches()
        return changedMsg
      }
      outcome = { ok: true as const }
    } catch (e) {
      const error = describeError(e)
      orca.log(`refresh failed: ${e instanceof OpenRouterError ? e.code : 'error'}`)
      if (superseded()) return changedMsg
      await orca.storage.set(
        'meta',
        { ...meta, lastError: error, errorSince: meta.errorSince ?? Date.now(), authFailed: isAuthProblem(e) } as never,
      )
      outcome = { ok: false as const, error }
    }
    // Side effects can fail (notifications, status bar) without making the refresh itself a failure.
    try {
      if (outcome.ok && (await orca.storage.get(KEY_LABEL)) == null) {
        const label = await getKeyMeta(createClient({ key })).catch(() => null)
        if (label) await orca.storage.set(KEY_LABEL, label.label as never)
      }
      await updateStatusBar()
      if (outcome.ok) await checkAlerts()
      await refreshDeepSeek()
    } catch (e) {
      orca.log(`post-refresh step failed: ${e instanceof Error ? e.message : 'error'}`)
    }
    return outcome
  }

  // Refreshes share one in-flight run, except after the key changed: that one waits for the old run
  // (which will discard its result) and then starts afresh.
  let refreshing: Promise<RefreshResult> | null = null
  let refreshEpoch = -1
  function refresh(): Promise<RefreshResult> {
    if (refreshing && refreshEpoch === epoch) return refreshing
    const previous = refreshing
    const startedAt = epoch
    refreshEpoch = startedAt
    const mine: Promise<RefreshResult> = (async () => {
      if (previous) await previous.catch(() => undefined)
      return doRefresh(startedAt)
    })().finally(async () => {
      if (refreshing === mine) refreshing = null
      try {
        orca.panels.post('report.changed', { at: Date.now() })
        await postStatus()
      } catch (e) {
        orca.log(`could not notify the panel: ${e instanceof Error ? e.message : 'error'}`)
      }
    })
    refreshing = mine
    detach(postStatus())
    return mine
  }

  async function reschedule(): Promise<void> {
    const minutes = (await readSettings()).refreshMinutes
    // Clear only after the await, so concurrent calls cannot each leave a timer behind.
    if (timer) clearInterval(timer)
    const handle = setInterval(() => {
      detach(orca.secrets.get(MGMT_KEY).then((k) => (k ? refresh() : undefined)))
    }, minutes * 60_000)
    // Don't hold the process open on the timer alone (the host keeps the worker alive).
    ;(handle as unknown as { unref?: () => void }).unref?.()
    timer = handle
  }

  // ---- optional DeepSeek account: balance only; its failures never fail the OpenRouter refresh ----
  type DsMeta = { error: string | null; authFailed: boolean }
  let dsEpoch = 0

  async function refreshDeepSeek(): Promise<void> {
    const key = await orca.secrets.get(DS_KEY)
    if (!key) return
    const mine = dsEpoch
    try {
      const account = await getBalance(key)
      if (mine !== dsEpoch) return
      const now = Date.now()
      await orca.storage.set('dsCache', { ...account, at: now } as never)
      await orca.storage.set('dsSnapshots', addSnapshots(await load<DeepSeekSnapshot[]>('dsSnapshots', []), account, now) as never)
      await orca.storage.set('dsMeta', { error: null, authFailed: false } as never)
    } catch (e) {
      if (mine !== dsEpoch) return
      orca.log(`deepseek refresh failed: ${e instanceof DeepSeekError ? e.code : 'error'}`)
      await orca.storage.set('dsMeta', { error: describeDeepSeekError(e), authFailed: e instanceof DeepSeekError && e.code === 'unauthorized' } as never)
    }
  }

  async function deepSeekView(): Promise<DeepSeekView | null> {
    if (!(await orca.secrets.get(DS_KEY))) return null
    const cache = await load<(DeepSeekAccount & { at: number }) | null>('dsCache', null)
    const snaps = await load<DeepSeekSnapshot[]>('dsSnapshots', [])
    const meta = await load<DsMeta>('dsMeta', { error: null, authFailed: false })
    const now = Date.now()
    return {
      label: await load<string>('dsLabel', 'DeepSeek key'),
      available: cache ? cache.available : null,
      balances: (cache?.balances ?? []).map((b) => {
        const burn = burnPerDay(snaps, b.currency, now)
        return { ...b, burnPerDay: burn, daysLeft: burn && burn > 0 ? b.total / burn : null }
      }),
      updatedAt: cache ? cache.at : null,
      error: meta.error,
      authFailed: meta.authFailed,
    }
  }

  orca.panels.handle('deepseek.get', () => deepSeekView())

  orca.panels.handle('deepseek.save', async ({ apiKey }) => {
    const key = String(apiKey ?? '').trim()
    if (!key || /\s/.test(key)) return { ok: false as const, error: 'Enter your DeepSeek API key.' }
    let account: DeepSeekAccount
    try {
      account = await getBalance(key)
    } catch (e) {
      return { ok: false as const, error: describeDeepSeekError(e) }
    }
    dsEpoch++
    for (const k of DS_STORE) await orca.storage.delete(k)
    await orca.secrets.set(DS_KEY, key)
    const now = Date.now()
    const label = maskKey(key)
    await orca.storage.set('dsLabel', label as never)
    await orca.storage.set('dsCache', { ...account, at: now } as never)
    await orca.storage.set('dsSnapshots', addSnapshots([], account, now) as never)
    await orca.storage.set('dsMeta', { error: null, authFailed: false } as never)
    orca.panels.post('report.changed', { at: now })
    return { ok: true as const, label }
  })

  orca.panels.handle('deepseek.test', async () => {
    if (!(await orca.secrets.get(DS_KEY))) return { ok: false as const, error: 'No DeepSeek key saved.' }
    await refreshDeepSeek()
    const meta = await load<DsMeta>('dsMeta', { error: null, authFailed: false })
    return meta.error ? { ok: false as const, error: meta.error } : { ok: true as const }
  })

  orca.panels.handle('deepseek.clear', async () => {
    dsEpoch++
    await orca.secrets.delete(DS_KEY)
    for (const k of DS_STORE) await orca.storage.delete(k)
    orca.panels.post('report.changed', { at: Date.now() })
    return { ok: true as const }
  })

  orca.panels.handle('status.get', () => status())

  // Verifies a management key; the label OpenRouter reports is masked, so it is safe to show.
  async function verifyKey(key: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
    try {
      const client = createClient({ key })
      const meta = await getKeyMeta(client)
      if (!meta.isManagement) {
        return { ok: false, error: 'That key is not a management key. Create one under OpenRouter Settings → Management Keys.' }
      }
      await getCredits(client)
      return { ok: true, label: meta.label }
    } catch (e) {
      return { ok: false, error: describeError(e) }
    }
  }

  orca.panels.handle('keys.save', async ({ mgmtKey }) => {
    const mgmt = mgmtKey.trim()
    if (!mgmt || /\s/.test(mgmt)) return { ok: false as const, error: 'Enter the management key.' }
    const verified = await verifyKey(mgmt)
    if (!verified.ok) return verified
    const previous = await orca.secrets.get(MGMT_KEY)
    try {
      await orca.secrets.set(MGMT_KEY, mgmt)
    } catch {
      return {
        ok: false as const,
        error: "Couldn't store the key: Orca has no secure key store here. On Linux, install a keyring service such as gnome-keyring, then try again.",
      }
    }
    epoch++
    // A different key may belong to another account: its numbers must not mix with the old ones.
    if (previous !== null && previous !== mgmt) {
      await wipeCaches()
      await orca.storage.delete('alerts')
    }
    await orca.storage.set(KEY_LABEL, verified.label as never)
    await orca.storage.set('meta', EMPTY_META as never)
    await refresh()
    await reschedule()
    return verified
  })

  orca.panels.handle('connection.test', async () => {
    const key = await orca.secrets.get(MGMT_KEY)
    if (!key) return { ok: false as const, error: 'No management key configured.' }
    const verified = await verifyKey(key)
    if (verified.ok) await orca.storage.set(KEY_LABEL, verified.label as never)
    return verified
  })

  orca.panels.handle('keys.clear', async () => {
    epoch++
    await orca.secrets.delete(MGMT_KEY)
    await wipeCaches()
    for (const k of ['alerts', KEY_LABEL]) await orca.storage.delete(k)
    await updateStatusBar()
    await postStatus()
    orca.panels.post('report.changed', { at: Date.now() })
    return { ok: true as const }
  })

  orca.panels.handle('settings.get', () => readSettings())

  async function applySettings(patch: Partial<Settings>): Promise<Settings> {
    const current = await readSettings()
    const next: Settings = { ...current }
    if (patch.refreshMinutes !== undefined) next.refreshMinutes = Math.round(clampNumber(patch.refreshMinutes, 1, 120, next.refreshMinutes))
    if (patch.lowBalanceUsd !== undefined) next.lowBalanceUsd = clampNumber(patch.lowBalanceUsd, 0, 1_000_000, next.lowBalanceUsd)
    if (patch.dailyBudgetUsd !== undefined) next.dailyBudgetUsd = clampNumber(patch.dailyBudgetUsd, 0, 1_000_000, next.dailyBudgetUsd)
    if (patch.monthlyBudgetUsd !== undefined) next.monthlyBudgetUsd = clampNumber(patch.monthlyBudgetUsd, 0, 1_000_000, next.monthlyBudgetUsd)
    if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications
    if (typeof patch.statusBar === 'boolean') next.statusBar = patch.statusBar
    if (patch.statusBarContent !== undefined && CONTENT_CHOICES.includes(patch.statusBarContent)) next.statusBarContent = patch.statusBarContent
    if (typeof patch.includeByok === 'boolean') next.includeByok = patch.includeByok
    if (patch.bannerColor !== undefined && BANNER_COLORS.includes(patch.bannerColor)) next.bannerColor = patch.bannerColor
    if (typeof patch.bannerVivid === 'boolean') next.bannerVivid = patch.bannerVivid
    const changed = (Object.keys(next) as (keyof Settings)[]).filter((k) => next[k] !== current[k])
    for (const k of changed) await orca.settings.set(k, next[k])
    // Alerts re-arm only when a threshold they depend on changed.
    if (changed.some((k) => ['lowBalanceUsd', 'dailyBudgetUsd', 'monthlyBudgetUsd'].includes(k))) {
      const alerts = await load<Alerts>('alerts', EMPTY_ALERTS)
      if (changed.includes('lowBalanceUsd')) alerts.lowFired = false
      if (changed.includes('dailyBudgetUsd')) alerts.budgetFiredDate = null
      if (changed.includes('monthlyBudgetUsd')) alerts.monthlyFiredMonth = null
      await orca.storage.set('alerts', alerts as never)
    }
    if (changed.length > 0) {
      await updateStatusBar()
      if (changed.includes('refreshMinutes')) await reschedule()
      orca.panels.post('report.changed', { at: Date.now() })
    }
    return next
  }

  // Changes apply one at a time, so two quick edits cannot overwrite each other's fields.
  let settingsQueue: Promise<unknown> = Promise.resolve()
  orca.panels.handle('settings.set', (patch) => {
    const run = settingsQueue.then(() => applySettings(patch))
    settingsQueue = run.catch(() => undefined)
    return run
  })

  orca.panels.handle('report.get', ({ range, measure }) => currentReport(range, measure))

  orca.panels.handle('export.csv', async ({ range, kind }) => {
    if (!['7d', '30d', 'all'].includes(range) || !['daily', 'models', 'keys'].includes(kind)) {
      throw Object.assign(new Error('Invalid export range or kind.'), { code: 'invalid_params' })
    }
    const settings = await readSettings()
    const report = await currentReport(range, 'cost', settings)
    if (!report) throw new Error('No usage data to export. Connect and refresh first.')
    return reportCsv(report, kind, settings.includeByok)
  })

  orca.panels.handle('refresh', () => refresh())

  orca.settings.onDidChange(({ key }) => {
    if (key === 'refreshMinutes') detach(reschedule())
    else detach(updateStatusBar())
  })

  detach(updateStatusBar())
  detach(reschedule())
  // Refresh on start so the status bar is current, but only when the cache is older than a minute.
  detach(load<Meta>('meta', EMPTY_META).then(async (meta) => {
    if (!(await orca.secrets.get(MGMT_KEY))) return
    if (meta.lastRefreshAt === null || Date.now() - meta.lastRefreshAt > 60_000) await refresh()
  }))
}
