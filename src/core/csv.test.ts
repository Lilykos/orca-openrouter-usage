import { assert, test } from 'orca/testing'
import { buildReport, normalizeKeys } from './report'
import { reportCsv } from './csv'

const report = () => buildReport({
  rows: [{ date: '2026-11-09', model: '=HYPERLINK("hostile")', endpoint: 'e', usage: 2, byokUsage: 3, requests: 4, prompt: 100, completion: 20, cached: 10, reasoning: 2 }],
  keys: normalizeKeys([{ hash: 'never-export-this-hash', name: '\t@hostile,"key"\nnext line', usage: 5, usage_daily: 1, last_used_at: '2026-11-09T12:00:00Z' }]),
  keyRows: {}, credits: { totalCredits: 20, totalUsage: 5 }, snapshots: [], now: Date.parse('2026-11-10T12:00:00Z'),
  range: '7d', measure: 'cost', includeByok: true, stale: null,
})

test('daily CSV contains UTC bounds, selected BYOK basis and approximate today', () => {
  const out = reportCsv(report(), 'daily', true)
  assert.equal(out.suggestedName, 'openrouter-daily-7d-2026-11-10.csv')
  assert.equal(out.mimeType, 'text/csv;charset=utf-8')
  assert.ok(out.data.includes('"2026-11-09","5","false"'))
  assert.ok(out.data.includes('"2026-11-10","1","true"'))
  assert.ok(out.data.includes('"2026-11-03","2026-11-10","true"'))
  assert.ok(out.data.endsWith('\r\n'))
})

test('CSV escapes commas, quotes and newlines and neutralizes spreadsheet formulas', () => {
  const r = report()
  const models = reportCsv(r, 'models', true).data
  assert.ok(models.includes('"\'=HYPERLINK(""hostile"")"'))
  const keys = reportCsv(r, 'keys', true).data
  assert.ok(keys.includes('"\'\t@hostile,""key""\nnext line"'))
  assert.ok(!keys.includes('never-export-this-hash'))
  // No per-key history has been fetched: an unknown amount stays blank, never zero.
  assert.ok(keys.includes('next line","","'))
})

test('empty CSV still has headers, and lifetime key bounds do not imply a historical window', () => {
  const r = report()
  r.models = []
  assert.equal(reportCsv(r, 'models', false).data.trim().split('\r\n').length, 1)
  r.range = 'all'
  assert.ok(reportCsv(r, 'keys', false).data.includes('"all","","2026-11-10","false"'))
})

test('CSV neutralizes each spreadsheet formula prefix including leading whitespace', () => {
  for (const name of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '  =1+1', '\r=1+1', '\n=1+1']) {
    const r = report()
    r.models[0].name = name
    assert.ok(reportCsv(r, 'models', false).data.includes('"\'' + name + '"'), name)
  }
})
