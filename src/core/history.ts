// Pure helpers for the stored day history and the intraday balance snapshots. Inputs are never mutated.

import type { DayRow } from '../protocol'

export type Snapshot = { t: number; totalUsage: number; totalCredits: number }

const DAY_MS = 24 * 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

function compareRows(a: DayRow, b: DayRow): number {
  return (
    a.date.localeCompare(b.date) ||
    a.model.localeCompare(b.model) ||
    a.endpoint.localeCompare(b.endpoint)
  )
}

/**
 * Replaces every date present in `fresh` with the fresh rows for that date; keeps stored rows for
 * all other dates. The result is sorted by date, model, endpoint. Idempotent.
 */
export function mergeDays(stored: DayRow[], fresh: DayRow[]): DayRow[] {
  const freshDates = new Set(fresh.map((r) => r.date))
  const kept = stored.filter((r) => !freshDates.has(r.date))
  return [...kept, ...fresh].sort(compareRows)
}

/**
 * Appends a snapshot unless the newest one is less than `minGapMs` older, then drops entries
 * older than `maxAgeMs` (relative to the new snapshot) and keeps only the newest `maxCount`.
 */
export function addSnapshot(
  list: Snapshot[],
  snap: Snapshot,
  opts: { minGapMs?: number; maxAgeMs?: number; maxCount?: number } = {}
): Snapshot[] {
  const minGapMs = opts.minGapMs ?? 2 * MINUTE_MS
  const maxAgeMs = opts.maxAgeMs ?? 35 * DAY_MS
  const maxCount = opts.maxCount ?? 3000

  const last = list.length > 0 ? list[list.length - 1] : undefined
  if (last && snap.t - last.t < minGapMs) return list.slice()

  const cutoff = snap.t - maxAgeMs
  const next = [...list, snap].filter((s) => s.t >= cutoff)
  return next.length > maxCount ? next.slice(next.length - maxCount) : next
}

/** Drops rows older than `maxDays` UTC days before `now`, so stored history cannot grow forever. */
export function pruneRows(rows: DayRow[], now: number, maxDays = 400): DayRow[] {
  const cutoff = new Date(now - maxDays * DAY_MS).toISOString().slice(0, 10)
  return rows.filter((r) => r.date >= cutoff)
}
