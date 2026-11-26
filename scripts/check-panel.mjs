#!/usr/bin/env node
// Regression checks for panel/index.html and the listing images. Needs Node 18+ and Chrome/Chromium
// (set CHROME to its path if it is not found). Run from the repo root: node scripts/check-panel.mjs
//
// It checks: the inline script parses; every tab and state renders its expected text; no NaN /
// Infinity / undefined leaks into the visible text; hostile model and key names are escaped (HTML
// injection); and the images in the manifest meet Orca's size limits.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const panelPath = join(root, 'panel/index.html')
const html = readFileSync(panelPath, 'utf8')
const tmp = mkdtempSync(join(tmpdir(), 'orpanel-'))
let failures = 0
const pass = (m) => console.log(`  ok   ${m}`)
const fail = (m) => {
  failures++
  console.log(`  FAIL ${m}`)
}
const section = (m) => console.log(`\n${m}`)

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'chrome',
  ].filter(Boolean)
  for (const c of candidates) {
    if (c.includes('/') ? existsSync(c) : spawnSync('which', [c]).status === 0) return c
  }
  return null
}

function dump(chrome, file, hash, budget = 6000) {
  const r = spawnSync(
    chrome,
    ['--headless=new', '--disable-gpu', '--no-sandbox', '--enable-logging=stderr', '--v=0', `--virtual-time-budget=${budget}`, '--dump-dom', `${pathToFileURL(file).href}#${hash}`],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
  )
  const dom = r.stdout ?? ''
  // An empty or app-less dump means Chrome failed or timed out: never let that read as a pass.
  if (!/id="app"[^>]*>\s*<\w/.test(dom)) throw new Error(`Chrome produced no rendered panel for #${hash} (${r.error?.message ?? 'empty DOM'})`)
  return { dom, log: r.stderr ?? '' }
}

const stripScripts = (dom) => dom.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '')
const visibleText = (dom) => stripScripts(dom).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ')

// ---- 1. the inline script parses ----
section('Script')
{
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  const main = scripts.sort((a, b) => b.length - a.length)[0]
  const f = join(tmp, 'main.js')
  writeFileSync(f, main)
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' })
  r.status === 0 ? pass('inline script parses') : fail(`script syntax: ${r.stderr.split('\n')[0]}`)
}

const chrome = findChrome()
if (!chrome) {
  console.log('\nChrome/Chromium not found: skipped the rendering checks (set CHROME).')
  process.exit(failures ? 1 : 2)
}

// ---- 2. every view renders what it should, with no junk values ----
section('Views')
const views = [
  ['overview', 'dark,tab=overview', ['Daily spend', 'Credits left', 'This month', 'by month end']],
  ['overview comparison', 'dark,tab=overview', ['vs previous 7 days'], { range: '7d' }],
  ['comparison needs history', 'dark,new,tab=overview', ['Collecting history'], { range: '7d' }],
  ['monthly budget', 'dark,budget,tab=overview', ['Monthly budget', 'used']],
  ['overview, tokens measure', 'dark,tab=overview', ['Daily tokens'], { measure: 'tokens' }],
  ['models, 7d', 'dark,tab=models', ['across'], { range: '7d' }],
  ['models', 'dark,tab=models', ['across', 'models']],
  ['models drawer', 'dark,tab=models,drawer', ['Requests', 'Cost per 1M tokens']],
  ['models, many (toggle shown)', 'dark,tab=models,many', ['Show 5 more']],
  ['keys', 'dark,tab=keys', ['API keys', 'in 30d']],
  ['key health', 'dark,tab=keys', ['Expiring soon', 'Expired', 'Near limit', 'Resets monthly']],
  ['ledger', 'light,tab=ledger', ['Daily ledger']],
  ['settings', 'dark,tab=settings', ['Connection', 'Status bar shows', 'follow UTC']],
  ['setup (not connected)', 'dark,setup', ['management key']],
  ['empty range', 'dark,empty', ['No activity']],
  ['stale data', 'dark,stale', ['cached data']],
  ['low balance', 'dark,low', ['Credits left']],
  ['new account (overview)', 'dark,new,tab=overview', ['No activity yet']],
  ['new account (models)', 'dark,new,tab=models', ['No models']],
  ['new account (keys)', 'dark,new,tab=keys', ['No API keys']],
  ['new account (ledger)', 'dark,new,tab=ledger', ['No days with activity']],
  ['offline', 'dark,offline', ["Couldn't load your usage"]],
]
// Seeds the panel's remembered range/measure in a temp copy, since the hash only picks tab and state.
function seeded(prefs) {
  const f = join(tmp, `seeded-${Object.values(prefs).join('-')}.html`)
  writeFileSync(f, html.replace('<script>', `<script>try{localStorage.setItem('openrouter-usage:prefs',JSON.stringify(${JSON.stringify(prefs)}))}catch(e){}</script><script>`))
  return f
}

for (const [name, hash, expect, prefs] of views) {
  let dom, log
  try {
    ;({ dom, log } = dump(chrome, prefs ? seeded(prefs) : panelPath, hash))
  } catch (e) {
    fail(`${name}: ${e.message}`)
    continue
  }
  
  const text = visibleText(dom)
  const missing = expect.filter((s) => !text.toLowerCase().includes(s.toLowerCase().replace(/'/g, '')) && !text.toLowerCase().includes(s.toLowerCase()))
  const junk = ['NaN', 'Infinity', 'undefined', '[object'].filter((s) => text.includes(s))
  const errors = log.split('\n').filter((l) => /Uncaught|TypeError|ReferenceError/.test(l))
  const problems = [
    ...(missing.length ? [`missing text: ${missing.join(', ')}`] : []),
    ...(junk.length ? [`junk in UI: ${junk.join(', ')}`] : []),
    ...(errors.length ? [`console error: ${errors[0].slice(0, 120)}`] : []),
  ]
  problems.length ? fail(`${name}: ${problems.join('; ')}`) : pass(name)
}

// ---- 3. hostile names must come out escaped ----
section('HTML injection')
{
  const payload = '<img src=x onerror=window.PWN=1 class=pwn>'
  let poisoned = html
  let hits = 0
  for (const name of ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini', 'google/gemini-2.5-flash', 'prod-api', 'staging', 'n8n automations', 'laptop-cli']) {
    for (const q of ["'", '"']) {
      if (poisoned.includes(q + name + q)) {
        poisoned = poisoned.replaceAll(q + name + q, q + name + payload + q)
        hits++
      }
    }
  }
  hits >= 3 ? pass(`poisoned ${hits} mock names`) : fail(`could not find the mock names to poison (${hits}); update the list in this script`)
  const f = join(tmp, 'poisoned.html')
  writeFileSync(f, poisoned)
  for (const tab of ['overview', 'models', 'keys', 'ledger', 'settings']) {
    let dom
    try {
      ;({ dom } = dump(chrome, f, `dark,tab=${tab}${tab === 'models' ? ',drawer' : ''}`))
    } catch (e) {
      fail(`${tab}: ${e.message}`)
      continue
    }
    const body = stripScripts(dom)
    const live = (body.match(/<img\b/g) || []).length
    live === 0 ? pass(`${tab}: no live <img> from hostile names`) : fail(`${tab}: ${live} live <img> element(s) came from hostile data`)
  }
}


// ---- 4. click-through behaviours (a script driven inside the page, like a person would) ----
section('Behaviours')
function drive(hash, steps) {
  const f = join(tmp, `drive-${hash.replace(/\W+/g, '-')}.html`)
  const driver = `<script>(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const results = [];
    const check = (name, ok) => results.push([name, !!ok]);
    const $ = (s) => document.querySelector(s);
    const txt = () => document.body.innerText;
    const click = async (s) => { const el = $(s); if (!el) { check('missing element ' + s, false); return false; } el.click(); await wait(250); return true; };
    try { await wait(900); ${steps} } catch (e) { check('script error: ' + e.message, false); }
    document.body.insertAdjacentHTML('beforeend', '<pre id="__results">' + JSON.stringify(results) + '</pre>');
  })();</script>`
  writeFileSync(f, html.replace('</body>', `${driver}</body>`))
  const { dom } = dump(chrome, f, hash, 45_000)
  const m = stripScripts(dom).match(/<pre id="__results">([\s\S]*?)<\/pre>/)
  if (!m) return [['the driver did not finish', false]]
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
}
const report = (results) => results.forEach(([name, ok]) => (ok ? pass(name) : fail(name)))

try {
  report(drive('dark', `
    for (const [tab, marker] of [['models', 'across'], ['keys', 'API keys'], ['ledger', 'Daily ledger'], ['settings', 'Connection'], ['overview', 'Daily spend']]) {
      await click('[data-act="tab"][data-val="' + tab + '"]');
      check('the ' + tab + ' tab shows its content', txt().includes(marker));
    }
    await click('[data-act="range"][data-val="7d"]'); await wait(400);
    check('switching to 7d updates the labels', /Last 7 days/.test(txt()));
    await click('[data-act="measure"][data-val="tokens"]'); await wait(400);
    check('switching to tokens retitles the chart', /Daily tokens/.test(txt()));
    await click('[data-act="tab"][data-val="models"]');
    await click('[data-act="model-open"]'); await wait(300);
    const dlg = $('[role="dialog"]');
    check('a model row opens the drawer', !!dlg && /Requests/.test(dlg.innerText));
    if (dlg) { dlg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await wait(300); }
    check('Escape closes the drawer', !$('[role="dialog"]'));
    await click('[data-act="tab"][data-val="overview"]');
    window.scrollTo(0, 260); await wait(200);
    const before = window.scrollY;
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('a background refresh does not move the scroll position', before > 100 && Math.abs(window.scrollY - before) < 5);
    window.scrollTo(0, 0);
    await click('[data-act="tab"][data-val="settings"]');
    const key = $('#mgmt'); key.value = 'sk-or-v1-half-typed'; key.focus();
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900); // what a finished worker refresh sends
    check('a key being typed survives a background refresh', $('#mgmt') && $('#mgmt').value === 'sk-or-v1-half-typed');
    const mins = document.querySelector('[data-fk="set:refreshMinutes"]');
    if (mins) { mins.focus(); mins.value = '4'; window.orca.emit('report.changed', { at: Date.now() }); await wait(900); }
    const mins2 = document.querySelector('[data-fk="set:refreshMinutes"]');
    check('a number being typed survives a background refresh', !!mins2 && mins2.value === '4');
    await click('[data-act="disconnect-ask"]');
    check('Disconnect asks for confirmation first', !!$('[data-act="disconnect-yes"]'));
    await click('[data-act="disconnect-no"]');
    check('cancelling keeps the connection', !$('[data-act="disconnect-yes"]') && /Connected as/.test(txt()));
    const sel = [...document.querySelectorAll('select')].find((s) => /Status bar shows/.test((s.closest('label') || s.parentElement || {}).innerText || ''));
    const toggle = $('[data-set="statusBar"]');
    if (toggle && sel) { toggle.click(); await wait(400); check('the status bar picker is disabled while the status bar is off', !!document.querySelector('select[disabled]')); }
    else check('status bar picker and toggle exist', false);
  `))
  report(drive('dark', `
    const tip = () => $('#tip');
    const hover = (el) => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); };
    await click('[data-act="measure"][data-val="cost"]'); await click('[data-act="range"][data-val="30d"]'); await wait(400);
    const bars = [...document.querySelectorAll('.chart .col[data-tip]')];
    check('the daily chart has bars to hover (' + bars.length + ')', bars.length > 2);
    const done = bars[bars.length - 2];
    if (done) { hover(done); await wait(150); }
    check('a chart bar tooltip lists every model that day, with no Other row', !!done && !tip().hidden && !/\\bOther\\b/.test(tip().innerText) && /llama-3.3-70b-instruct/.test(tip().innerText));
    const today = bars[bars.length - 1];
    if (today) { hover(today); await wait(150); }
    check('the partial today bar is not labelled as Other', !!today && /not split yet/.test(tip().innerText) && !/\\bOther\\b/.test(tip().innerText));
    await click('[data-act="tab"][data-val="ledger"]');
    const rows = [...document.querySelectorAll('.lg-row')];
    check('every ledger row carries a split tooltip and is focusable', rows.length > 0 && rows.every((r) => r.dataset.tip && r.tabIndex === 0));
    const past = rows.find((r) => !r.classList.contains('partial'));
    if (past) { hover(past); await wait(150); }
    check('hovering a ledger day shows its split per model', !!past && !tip().hidden && /Total/.test(tip().innerText) && tip().querySelectorAll('.row').length >= 3 && !/\\bOther\\b/.test(tip().innerText) && /llama-3.3-70b-instruct/.test(tip().innerText));
    if (past) { past.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); await wait(100); }
    check('leaving a ledger row hides the tooltip', tip().hidden);
  `))
  report(drive('dark,tab=models,many', `
    const rows = () => document.querySelectorAll('[data-act="model-open"]').length;
    check('only the top 8 models show at first', rows() === 8);
    await click('[data-act="models-more"]');
    check('"Show more" reveals the rest (13 in all)', rows() === 13);
    check('the toggle now offers "Show less"', /Show less/.test(txt()));
    await click('[data-act="models-more"]');
    check('"Show less" collapses back to 8', rows() === 8);
  `))
  report(drive('dark,setup', `
    const input = $('#mgmt');
    check('setup shows the key form', !!input);
    input.value = 'bad'; await click('[data-act="save-keys"]'); await wait(600);
    check('a rejected key shows its error and stays on setup', !!$('#mgmt') && /rejected|not|invalid|Enter|error/i.test(txt()));
    $('#mgmt').value = 'sk-or-v1-good'; await click('[data-act="save-keys"]'); await wait(1200);
    check('a verified key leads to the dashboard', !!$('[data-act="tab"][data-val="overview"]'));
  `))
  report(drive('dark', `
    let offered = null;
    window.orca.files = { async saveAs(options) { offered = options; return { status: 'saved' }; } };
    await click('[data-act="export"]'); await wait(700);
    check('CSV export offers a daily CSV through the save dialog', offered && /daily/.test(offered.suggestedName) && /spend_usd/.test(offered.data));
    check('a saved CSV reports success', /CSV saved/.test(txt()));
    const kind = $('[data-export-kind]');
    if (kind) kind.value = 'models';
    await click('[data-act="export"]'); await wait(700);
    check('the export picker can choose models', offered && /models/.test(offered.suggestedName));
    window.orca.files.saveAs = async () => ({ status: 'cancelled' });
    await click('[data-act="export"]'); await wait(700);
    check('cancelling the save dialog is not reported as success', /Export cancelled/.test(txt()) && !/CSV saved/.test(txt()));
    window.orca.files.saveAs = async () => { throw new Error('disk unavailable'); };
    await click('[data-act="export"]'); await wait(700);
    check('a save error is visible and exporting can be retried', /Export failed: disk unavailable/.test(txt()) && !$('[data-act="export"]').disabled);
    document.documentElement.style.setProperty('--orca-font-sans', 'monospace');
    check('the panel follows Orca font preferences', getComputedStyle(document.body).fontFamily.includes('monospace'));
  `))
  report(drive('dark,tab=settings', `
    const budget = $('[data-set="monthlyBudgetUsd"]');
    check('Settings has an optional monthly budget', !!budget && +budget.value === 0);
    if (budget) {
      budget.value = '100'; budget.dispatchEvent(new Event('change', { bubbles: true })); await wait(900);
      await click('[data-act="tab"][data-val="overview"]'); await wait(800);
      check('saving a monthly budget shows progress on Overview', !!$('[aria-label="Monthly budget used"]') && /of \\$100.00/.test(txt()));
      await click('[data-act="tab"][data-val="settings"]'); await wait(500);
      const input = $('[data-set="monthlyBudgetUsd"]');
      input.value = '0'; input.dispatchEvent(new Event('change', { bubbles: true })); await wait(900);
      await click('[data-act="tab"][data-val="overview"]'); await wait(800);
      check('setting the monthly budget to zero hides progress', !$('[aria-label="Monthly budget used"]'));
    }
  `))
} catch (e) {
  fail(`behaviour run: ${e.message}`)
}

// ---- 5. listing images meet Orca's limits ----
section('Listing images')
{
  const manifest = JSON.parse(readFileSync(join(root, 'orca-plugin.json'), 'utf8'))
  const png = (p) => {
    const b = readFileSync(join(root, p))
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), kb: statSync(join(root, p)).size / 1024 }
  }
  const check = (label, p, { minW, minH, maxKB, square }) => {
    if (!p || !existsSync(join(root, p))) return fail(`${label}: file missing (${p})`)
    const { w, h, kb } = png(p)
    const bad = [w < minW || h < minH ? `${w}x${h} is below ${minW}x${minH}` : '', square && w !== h ? 'not square' : '', kb > maxKB ? `${Math.round(kb)} KB over ${maxKB} KB` : ''].filter(Boolean)
    bad.length ? fail(`${label}: ${bad.join('; ')}`) : pass(`${label}: ${w}x${h}, ${Math.round(kb)} KB`)
  }
  check('icon', manifest.icon, { minW: 128, minH: 128, maxKB: 256, square: true })
  check('cover', manifest.cover?.path, { minW: 800, minH: 500, maxKB: 1024 })
  let total = 0
  for (const s of manifest.screenshots ?? []) {
    check(`screenshot ${s.path}`, s.path, { minW: 1280, minH: 800, maxKB: 1536 })
    if (existsSync(join(root, s.path))) total += png(s.path).kb
    if (!s.alt) fail(`screenshot ${s.path}: alt text is required`)
  }
  ;(manifest.screenshots ?? []).length <= 6 ? pass('at most 6 screenshots') : fail('more than 6 screenshots')
  total <= 8192 ? pass(`screenshots total ${Math.round(total)} KB`) : fail('screenshots exceed 8 MB')
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed')
process.exit(failures ? 1 : 0)
