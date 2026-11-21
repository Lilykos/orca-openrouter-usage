import type { CsvExport, ExportKind, Report } from '../protocol'

// Quote every cell; prefix untrusted spreadsheet formulas even when they start with whitespace.
function cell(value: string | number | boolean | null | undefined): string {
  let text = value == null || typeof value === 'number' && !Number.isFinite(value) ? '' : String(value)
  if (typeof value === 'string' && (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text
  return '"' + text.replace(/"/g, '""') + '"'
}

export function reportCsv(report: Report, kind: ExportKind, includeByok: boolean): CsvExport {
  const today = new Date(report.generatedAt).toISOString().slice(0, 10)
  const day = (offset: number): string => new Date(Date.parse(today + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10)
  const start = report.range === 'all' ? kind === 'keys' ? '' : report.heatmap[0]?.date ?? '' : day(report.range === '7d' ? -7 : -30)
  const end = kind === 'daily' || kind === 'keys' && report.range === 'all' ? today : day(-1)
  const metadata = [new Date(report.generatedAt).toISOString(), report.range, start, end, includeByok]
  const header = ['generated_at_utc', 'range', 'range_start_utc', 'range_end_utc', 'include_byok']
  type Row = (string | number | boolean | null | undefined)[]
  let columns: string[], rows: Row[]
  if (kind === 'daily') {
    columns = ['date_utc', 'spend_usd', 'approximate_today']
    rows = report.daily.map((d) => [d.date, d.total, d.partial])
  } else if (kind === 'models') {
    columns = ['model', 'spend_usd', 'previous_spend_usd', 'requests', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'cached_tokens']
    rows = report.models.map((m) => [m.name, m.cost, m.previousCost, m.requests, m.prompt, m.completion, m.reasoning, m.cached])
  } else {
    columns = ['key_name', 'spend_usd', 'limit_usd', 'limit_remaining_usd', 'disabled', 'expires_at_utc', 'limit_reset', 'include_byok_in_limit']
    rows = report.keys.map((k) => [k.name || k.label || 'Unnamed key', k.spend, k.limit, k.limitRemaining, k.disabled, k.expiresAt, k.limitReset, k.includeByokInLimit])
  }
  return {
    suggestedName: `openrouter-${kind}-${report.range}-${today}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    data: [[...header, ...columns], ...rows.map((r) => [...metadata, ...r])].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n',
  }
}
