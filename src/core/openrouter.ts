// Thin, GET-only client for the OpenRouter management API. Raw objects are returned as-is;
// mapping them to protocol types happens elsewhere. Errors never carry the API key.

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

export type OpenRouterErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'server'
  | 'network'
  | 'bad_response'

export class OpenRouterError extends Error {
  status: number
  code: OpenRouterErrorCode
  retryAfterMs?: number

  constructor(code: OpenRouterErrorCode, status: number, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'OpenRouterError'
    this.code = code
    this.status = status
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

export type Query = Record<string, string | number | boolean>

export type OpenRouterClientOptions = {
  key: string
  fetch?: typeof fetch
  baseUrl?: string
  sleep?: (ms: number) => Promise<void>
}

export type OpenRouterClient = {
  get<T>(path: string, query?: Query): Promise<T>
}

const TIMEOUT_MS = 15_000
const RATE_LIMIT_DELAYS_MS = [1000, 2000, 4000]
/** Longest we are willing to wait out a 429 before reporting rate_limited. */
const MAX_RETRY_WAIT_MS = 10_000
const SERVER_DELAYS_MS = [1000, 2000]
const KEYS_PAGE_SIZE = 100
const KEYS_MAX_PAGES = 20

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Retry-After in seconds; undefined when absent or not a number of seconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined
  const seconds = Number(header.trim())
  if (!Number.isFinite(seconds) || seconds < 0) return undefined
  return Math.round(seconds * 1000)
}

function statusError(status: number, path: string, retryAfterMs?: number): OpenRouterError {
  const where = `OpenRouter ${path} responded ${status}`
  if (status === 401) return new OpenRouterError('unauthorized', status, `${where}: key rejected`, retryAfterMs)
  if (status === 403) return new OpenRouterError('forbidden', status, `${where}: key lacks permission`, retryAfterMs)
  if (status === 429) return new OpenRouterError('rate_limited', status, `${where}: rate limited`, retryAfterMs)
  if (status >= 500) return new OpenRouterError('server', status, `${where}: server error`, retryAfterMs)
  return new OpenRouterError('bad_response', status, `${where}: unexpected status`, retryAfterMs)
}

export function badResponse(path: string): OpenRouterError {
  return new OpenRouterError('bad_response', 200, `OpenRouter ${path} returned an unexpected body`)
}

export function createClient(opts: OpenRouterClientOptions): OpenRouterClient {
  const baseUrl = opts.baseUrl ?? OPENROUTER_BASE_URL
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init))
  const sleep = opts.sleep ?? defaultSleep

  async function get<T>(path: string, query?: Query): Promise<T> {
    const url = new URL(baseUrl + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    }
    let rateRetries = 0
    let serverRetries = 0
    for (;;) {
      let res: Response
      try {
        res = await doFetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: `Bearer ${opts.key}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS)
        })
      } catch {
        // Deliberately generic: the underlying error text is not surfaced.
        throw new OpenRouterError('network', 0, `Network error contacting OpenRouter ${path}`)
      }

      if (res.ok) {
        try {
          return (await res.json()) as T
        } catch {
          throw badResponse(path)
        }
      }

      const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
      if (res.status === 429 && rateRetries < RATE_LIMIT_DELAYS_MS.length) {
        const delay = retryAfterMs ?? RATE_LIMIT_DELAYS_MS[rateRetries]
        // A long Retry-After would stall the shared refresh (and the panel) for that long: fail fast instead.
        if (delay > MAX_RETRY_WAIT_MS) throw statusError(res.status, path, retryAfterMs)
        rateRetries++
        await sleep(delay)
        continue
      }
      if (res.status >= 500 && serverRetries < SERVER_DELAYS_MS.length) {
        const delay = SERVER_DELAYS_MS[serverRetries]
        serverRetries++
        await sleep(delay)
        continue
      }
      throw statusError(res.status, path, retryAfterMs)
    }
  }

  return { get }
}

function dataOf(body: unknown, path: string): Record<string, unknown> {
  const data = (body as { data?: unknown } | null)?.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw badResponse(path)
  return data as Record<string, unknown>
}

function arrayOf(body: unknown, path: string): any[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) throw badResponse(path)
  return data
}

export async function getCredits(c: OpenRouterClient): Promise<{ totalCredits: number; totalUsage: number }> {
  const path = '/credits'
  const data = dataOf(await c.get<unknown>(path), path)
  if (typeof data.total_credits !== 'number' || typeof data.total_usage !== 'number') throw badResponse(path)
  return { totalCredits: data.total_credits, totalUsage: data.total_usage }
}

export async function getKeyMeta(c: OpenRouterClient): Promise<{ isManagement: boolean; label: string }> {
  const path = '/key'
  const data = dataOf(await c.get<unknown>(path), path)
  if (typeof data.is_management_key !== 'boolean' || typeof data.label !== 'string') throw badResponse(path)
  return { isManagement: data.is_management_key, label: data.label }
}

/** All API keys, including disabled ones. Pages until a short or empty page (at most 20 pages). */
export async function listKeys(c: OpenRouterClient): Promise<any[]> {
  const path = '/keys'
  const all: any[] = []
  for (let page = 0; page < KEYS_MAX_PAGES; page++) {
    const items = arrayOf(
      await c.get<unknown>(path, { include_disabled: true, offset: page * KEYS_PAGE_SIZE }),
      path
    )
    all.push(...items)
    if (items.length < KEYS_PAGE_SIZE) break
  }
  return all
}

/** Raw /activity rows for one API key (all completed days in one call). */
export async function getKeyActivity(c: OpenRouterClient, keyHash: string): Promise<any[]> {
  const path = '/activity'
  return arrayOf(await c.get<unknown>(path, { api_key_hash: keyHash }), path)
}

/** Raw /activity rows. Omit `date` for every completed day in one call. */
export async function getActivity(c: OpenRouterClient, date?: string): Promise<any[]> {
  const path = '/activity'
  return arrayOf(await c.get<unknown>(path, date ? { date } : undefined), path)
}
