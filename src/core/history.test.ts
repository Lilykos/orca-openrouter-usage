import { test, assert } from 'orca/testing'
import type { DayRow } from '../protocol'
import { mergeDays, addSnapshot, pruneRows, type Snapshot } from './history'

const row = (over: Partial<DayRow> & Pick<DayRow, 'date'>): DayRow => ({
  model: 'm/a',
  endpoint: 'e1',
  usage: 1,
  byokUsage: 0,
  requests: 1,
  prompt: 10,
  completion: 5,
  reasoning: 0,
  cached: 0,
  ...over
})

const DAY = 24 * 60 * 60 * 1000
const MIN = 60 * 1000

test('mergeDays replaces whole dates from fresh and keeps other stored dates', () => {
  const stored = [
    row({ date: '2026-11-01', usage: 1 }),
    row({ date: '2026-11-01', model: 'm/b', usage: 2 }),
    row({ date: '2026-11-02', usage: 3 })
  ]
  const fresh = [row({ date: '2026-11-01', usage: 9 })]
  const merged = mergeDays(stored, fresh)
  assert.deepEqual(merged, [row({ date: '2026-11-01', usage: 9 }), row({ date: '2026-11-02', usage: 3 })])
})

test('mergeDays drops stored rows of a fresh date even when fresh has fewer rows', () => {
  const stored = [row({ date: '2026-11-01', model: 'gone' }), row({ date: '2026-11-01', model: 'other' })]
  const merged = mergeDays(stored, [row({ date: '2026-11-01', model: 'other' })])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].model, 'other')
})

test('mergeDays keeps dates that only appear in stored, and adds dates only in fresh', () => {
  const merged = mergeDays([row({ date: '2026-10-01' })], [row({ date: '2026-11-01' })])
  assert.deepEqual(
    merged.map((r) => r.date),
    ['2026-10-01', '2026-11-01']
  )
})

test('mergeDays sorts by date, model, endpoint', () => {
  const merged = mergeDays(
    [],
    [
      row({ date: '2026-11-02', model: 'a' }),
      row({ date: '2026-11-01', model: 'b', endpoint: 'e3' }),
      row({ date: '2026-11-01', model: 'b', endpoint: 'e2' }),
      row({ date: '2026-11-01', model: 'b', endpoint: 'e1' }),
      row({ date: '2026-11-01', model: 'a' })
    ]
  )
  assert.deepEqual(
    merged.map((r) => `${r.date}|${r.model}|${r.endpoint}`),
    [
      '2026-11-01|a|e1',
      '2026-11-01|b|e1',
      '2026-11-01|b|e2',
      '2026-11-01|b|e3',
      '2026-11-02|a|e1'
    ]
  )
})

test('mergeDays is idempotent', () => {
  const stored = [row({ date: '2026-11-01', usage: 1 }), row({ date: '2026-10-30', usage: 4 })]
  const fresh = [row({ date: '2026-11-01', usage: 2 }), row({ date: '2026-11-03', usage: 5 })]
  const once = mergeDays(stored, fresh)
  const twice = mergeDays(once, fresh)
  assert.deepEqual(twice, once)
})

test('mergeDays does not mutate its inputs', () => {
  const stored = [row({ date: '2026-11-02' }), row({ date: '2026-11-01' })]
  const fresh = [row({ date: '2026-11-01', usage: 7 })]
  const storedCopy = JSON.parse(JSON.stringify(stored))
  const freshCopy = JSON.parse(JSON.stringify(fresh))
  mergeDays(stored, fresh)
  assert.deepEqual(stored, storedCopy)
  assert.deepEqual(fresh, freshCopy)
})

const snap = (t: number, totalUsage = 1, totalCredits = 10): Snapshot => ({ t, totalUsage, totalCredits })

test('addSnapshot appends to an empty list', () => {
  assert.deepEqual(addSnapshot([], snap(1000)), [snap(1000)])
})

test('addSnapshot skips a snapshot closer than minGapMs (default 2 minutes) to the last one', () => {
  const list = [snap(0)]
  assert.deepEqual(addSnapshot(list, snap(2 * MIN - 1, 5)), list)
  assert.equal(addSnapshot(list, snap(2 * MIN)).length, 2)
});

test('addSnapshot honours a custom minGapMs', () => {
  const list = [snap(0)]
  assert.equal(addSnapshot(list, snap(500), { minGapMs: 1000 }).length, 1)
  assert.equal(addSnapshot(list, snap(1000), { minGapMs: 1000 }).length, 2)
})

test('addSnapshot drops entries older than maxAgeMs (default 35 days)', () => {
  const now = 100 * DAY
  const list = [snap(now - 36 * DAY), snap(now - 35 * DAY), snap(now - 10 * DAY)]
  const out = addSnapshot(list, snap(now))
  assert.deepEqual(
    out.map((s) => s.t),
    [now - 35 * DAY, now - 10 * DAY, now]
  )
})

test('addSnapshot honours a custom maxAgeMs', () => {
  const out = addSnapshot([snap(0), snap(5 * MIN)], snap(10 * MIN), { maxAgeMs: 6 * MIN })
  assert.deepEqual(
    out.map((s) => s.t),
    [5 * MIN, 10 * MIN]
  )
})

test('addSnapshot keeps only the newest maxCount (default 3000)', () => {
  let list: Snapshot[] = []
  for (let i = 0; i < 3005; i++) list = addSnapshot(list, snap(i * 3 * MIN))
  assert.equal(list.length, 3000)
  assert.equal(list[0].t, 5 * 3 * MIN)
  assert.equal(list[list.length - 1].t, 3004 * 3 * MIN)
})

test('addSnapshot honours a custom maxCount', () => {
  const out = addSnapshot([snap(0), snap(3 * MIN), snap(6 * MIN)], snap(9 * MIN), { maxCount: 2 })
  assert.deepEqual(
    out.map((s) => s.t),
    [6 * MIN, 9 * MIN]
  )
})

test('addSnapshot never mutates its input list', () => {
  const list = [snap(0), snap(3 * MIN)]
  const copy = JSON.parse(JSON.stringify(list))
  addSnapshot(list, snap(10 * MIN), { maxCount: 1 })
  addSnapshot(list, snap(1 * MIN))
  assert.deepEqual(list, copy)
})

test('pruneRows drops rows older than the cutoff and keeps the rest', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  const rows = [row({ date: '2025-09-01' }), row({ date: '2025-10-06' }), row({ date: '2026-11-09' })]
  assert.deepEqual(pruneRows(rows, now, 400).map((r) => r.date), ['2025-10-06', '2026-11-09'])
  assert.equal(rows.length, 3) // input untouched
  assert.deepEqual(pruneRows(rows, now, 5).map((r) => r.date), ['2026-11-09'])
})
