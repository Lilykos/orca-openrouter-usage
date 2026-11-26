import { test, assert } from 'orca/testing'
import { DeepSeekError, addSnapshots, burnPerDay, getBalance, maskKey, parseBalance } from './deepseek'

const H = 3_600_000
const D = 24 * H
const NOW = Date.parse('2026-11-26T12:00:00Z')
const body = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '12.50', granted_balance: '2.50', topped_up_balance: '10.00' }] }

test('parseBalance reads string amounts as numbers', () => {
  assert.deepEqual(parseBalance(body), { available: true, balances: [{ currency: 'USD', total: 12.5, granted: 2.5, toppedUp: 10 }] })
})

test('parseBalance keeps every currency and skips unreadable rows', () => {
  const out = parseBalance({ is_available: false, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }, { currency: 'USD', total_balance: 'n/a' }] })
  assert.equal(out.available, false)
  assert.deepEqual(out.balances, [{ currency: 'CNY', total: 110, granted: 0, toppedUp: 0 }])
})

test('parseBalance rejects a body without the expected fields', () => {
  assert.throws(() => parseBalance({ balance_infos: [] }), (e: unknown) => e instanceof DeepSeekError)
  assert.throws(() => parseBalance(null), (e: unknown) => e instanceof DeepSeekError)
})

test('getBalance sends the key as a bearer token and maps failures', async () => {
  let auth = ''
  const ok = (async (_: RequestInfo | URL, init?: RequestInit) => {
    auth = String((init?.headers as Record<string, string>).Authorization)
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
  assert.equal((await getBalance('sk-test', ok)).balances[0].total, 12.5)
  assert.equal(auth, 'Bearer sk-test')
  const status = (s: number) => (async () => new Response('{}', { status: s })) as typeof fetch
  const codeOf = async (f: typeof fetch) => { try { await getBalance('sk', f) } catch (e) { return (e as DeepSeekError).code } return 'none' }
  assert.equal(await codeOf(status(401)), 'unauthorized')
  assert.equal(await codeOf(status(429)), 'rate_limited')
  assert.equal(await codeOf(status(503)), 'server')
  assert.equal(await codeOf((async () => { throw new TypeError('down') }) as typeof fetch), 'network')
})

test('burn is the drops between readings per day, ignoring top-ups', () => {
  const snaps = [
    { t: NOW - 2 * D, currency: 'USD', total: 20 },
    { t: NOW - 1 * D, currency: 'USD', total: 18 },   // spent 2
    { t: NOW - 12 * H, currency: 'USD', total: 40 },  // a top-up: ignored
    { t: NOW, currency: 'USD', total: 38 },           // spent 2
  ]
  assert.equal(burnPerDay(snaps, 'USD', NOW), 2) // 4 spent over 2 days
})

test('burn needs at least 12 hours of history and the same currency', () => {
  assert.equal(burnPerDay([{ t: NOW - 2 * H, currency: 'USD', total: 5 }, { t: NOW, currency: 'USD', total: 4 }], 'USD', NOW), null)
  assert.equal(burnPerDay([{ t: NOW - D, currency: 'CNY', total: 5 }, { t: NOW, currency: 'CNY', total: 4 }], 'USD', NOW), null)
})

test('snapshots keep two weeks, one reading per currency', () => {
  const old = [{ t: NOW - 20 * D, currency: 'USD', total: 1 }, { t: NOW - D, currency: 'USD', total: 2 }]
  const out = addSnapshots(old, { available: true, balances: [{ currency: 'USD', total: 3, granted: 0, toppedUp: 3 }, { currency: 'CNY', total: 9, granted: 0, toppedUp: 9 }] }, NOW)
  assert.deepEqual(out.map((s) => [s.currency, s.total]), [['USD', 2], ['USD', 3], ['CNY', 9]])
})

test('maskKey shows only the prefix and last four characters', () => {
  assert.equal(maskKey('sk-0123456789abcdef'), 'sk-…cdef')
  assert.equal(maskKey('short'), '••••')
})
