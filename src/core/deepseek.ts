// Optional DeepSeek account: its balance, and a burn rate worked out from balance snapshots.
// DeepSeek's API exposes only the current balance (GET /user/balance), not usage history.
// Errors never carry the API key.

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'

export type DeepSeekErrorCode = 'unauthorized' | 'rate_limited' | 'server' | 'network' | 'bad_response'

export class DeepSeekError extends Error {
  status: number
  code: DeepSeekErrorCode
  constructor(code: DeepSeekErrorCode, status: number, message: string) {
    super(message)
    this.name = 'DeepSeekError'
    this.code = code
    this.status = status
  }
}

export interface DeepSeekBalance {
  currency: string
  total: number
  granted: number
  toppedUp: number
}

export interface DeepSeekAccount {
  /** DeepSeek's own flag: whether the balance is enough for API calls. */
  available: boolean
  balances: DeepSeekBalance[]
}

/** One balance reading per currency. */
export interface DeepSeekSnapshot {
  t: number
  currency: string
  total: number
}

const TIMEOUT_MS = 15_000
const DAY_MS = 86_400_000
const BURN_WINDOW_DAYS = 7
/** Snapshots older than this are dropped. */
const KEEP_DAYS = 14
/** A burn rate needs at least this much history, or it is too noisy to project from. */
const MIN_SPAN_MS = 12 * 3_600_000

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : null
}

/** Parses DeepSeek's balance body. Amounts arrive as strings ("110.00"). */
export function parseBalance(body: unknown): DeepSeekAccount {
  const b = body as { is_available?: unknown; balance_infos?: unknown } | null
  if (!b || typeof b.is_available !== 'boolean' || !Array.isArray(b.balance_infos)) {
    throw new DeepSeekError('bad_response', 200, 'DeepSeek /user/balance returned an unexpected body')
  }
  const balances: DeepSeekBalance[] = []
  for (const raw of b.balance_infos as Record<string, unknown>[]) {
    const total = num(raw?.total_balance)
    if (typeof raw?.currency !== 'string' || total === null) continue
    balances.push({ currency: raw.currency, total, granted: num(raw.granted_balance) ?? 0, toppedUp: num(raw.topped_up_balance) ?? 0 })
  }
  return { available: b.is_available, balances }
}

export async function getBalance(key: string, doFetch: typeof fetch = (i, init) => fetch(i, init)): Promise<DeepSeekAccount> {
  let res: Response
  try {
    res = await doFetch(DEEPSEEK_BASE_URL + '/user/balance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new DeepSeekError('network', 0, 'Network error contacting DeepSeek')
  }
  if (res.status === 401 || res.status === 403) throw new DeepSeekError('unauthorized', res.status, 'DeepSeek rejected the key')
  if (res.status === 429) throw new DeepSeekError('rate_limited', res.status, 'DeepSeek is rate limiting requests')
  if (res.status >= 500) throw new DeepSeekError('server', res.status, 'DeepSeek had a server error')
  if (!res.ok) throw new DeepSeekError('bad_response', res.status, `DeepSeek responded ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new DeepSeekError('bad_response', res.status, 'DeepSeek returned an unreadable body')
  }
  return parseBalance(body)
}

export function describeDeepSeekError(e: unknown): string {
  if (!(e instanceof DeepSeekError)) return 'Something went wrong talking to DeepSeek.'
  switch (e.code) {
    case 'unauthorized':
      return 'DeepSeek rejected this key. It may be mistyped or revoked.'
    case 'rate_limited':
      return 'DeepSeek is rate limiting requests. Try again in a minute.'
    case 'server':
      return 'DeepSeek had a problem on its side. Try again shortly.'
    case 'network':
      return "Can't reach DeepSeek. Check your internet connection."
    default:
      return 'DeepSeek sent an unexpected response.'
  }
}

/** Adds this reading (one snapshot per currency) and drops readings older than two weeks. */
export function addSnapshots(prev: DeepSeekSnapshot[], account: DeepSeekAccount, now: number): DeepSeekSnapshot[] {
  const kept = prev.filter((s) => s.t >= now - KEEP_DAYS * DAY_MS && s.t < now)
  return [...kept, ...account.balances.map((b) => ({ t: now, currency: b.currency, total: b.total }))]
}

/**
 * Mean spend per day for one currency over the last 7 days of snapshots: the drops between readings,
 * divided by the time they cover. Rises are top-ups and are ignored. Null with under 12 hours of history.
 */
export function burnPerDay(snapshots: DeepSeekSnapshot[], currency: string, now: number): number | null {
  const pts = snapshots
    .filter((s) => s.currency === currency && s.t >= now - BURN_WINDOW_DAYS * DAY_MS && s.t <= now)
    .sort((a, b) => a.t - b.t)
  if (pts.length < 2) return null
  const span = pts[pts.length - 1].t - pts[0].t
  if (span < MIN_SPAN_MS) return null
  let spent = 0
  for (let i = 1; i < pts.length; i++) spent += Math.max(0, pts[i - 1].total - pts[i].total)
  return spent / (span / DAY_MS)
}

/** Masks a key for display: its prefix and last four characters only. */
export function maskKey(key: string): string {
  const k = key.trim()
  return k.length <= 10 ? '••••' : `${k.slice(0, 3)}…${k.slice(-4)}`
}
