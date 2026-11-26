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
  ['usage', 'dark', ['OpenRouter Usage', 'Credits left', 'Add credits', 'Spend', 'on pace for', 'Models', 'Token mix', 'cache hit', 'Activity']],
  ['usage, light', 'light', ['Credits left', 'Token mix', 'Activity']],
  ['comparison', 'dark', ['previous 7'], { range: '7d' }],
  ['comparison needs history', 'dark,new', ['after more history'], { range: '7d' }],
  ['monthly budget', 'dark,budget', ['Budget $25.00', 'budget']],
  ['tokens measure', 'dark', ['Tokens', 'cache hit', 'tokens in total'], { measure: 'tokens' }],
  ['open sections', 'dark,open', ['prompt to output', 'Cached prompt', 'Click a day to select it']],
  ['7-day range', 'dark', ['last 7 days'], { range: '7d' }],
  ['many models', 'dark,many', ['13 used', 'extra-model-7']],
  ['keys', 'dark,tab=keys', ['API keys', 'active keys', 'inactive keys']],
  ['key health', 'dark,tab=keys', ['Expires', 'Near limit', 'resets monthly']],
  ['key warnings under the banner', 'dark', ['expires', 'has used 94% of its']],
  ['settings', 'dark,tab=settings', ['Account', 'Appearance', 'Colour', 'Vivid', 'Alerts and budgets', 'Low balance', 'Status bar', 'Next to credits', 'Data', 'Refresh every', 'Count BYOK usage', 'Days follow UTC']],
  ['vivid gold banner', 'dark,banner=gold,vivid', ['Credits left']],
  ['quiet graphite banner, low credits', 'light,low,banner=graphite', ['Credits left', 'days left']],
  ['setup (not connected)', 'dark,setup', ['management key']],
  ['empty range', 'dark,empty', ['No models in this range']],
  ['stale data', 'dark,stale', ['cached data']],
  ['low balance', 'dark,low', ['days left', 'until around']],
  ['new account (usage)', 'dark,new', ['No models', 'No recent spend']],
  ['new account (keys)', 'dark,new,tab=keys', ['No API keys']],
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
  for (const tab of ['usage', 'keys', 'settings']) {
    let dom
    try {
      ;({ dom } = dump(chrome, f, `dark,tab=${tab}`))
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
    localStorage.clear();
    for (const [tab, marker] of [['keys', 'API keys'], ['settings', 'Alerts and budgets'], ['usage', 'Token mix']]) {
      await click('[data-act="tab"][data-val="' + tab + '"]');
      check('the ' + tab + ' tab shows its content', txt().includes(marker));
    }
    await click('[data-act="range"][data-val="7d"]'); await wait(500);
    check('switching to 7D updates the labels', /last 7 days/.test(txt()));
    await click('[data-act="measure"][data-val="tokens"]'); await wait(500);
    check('switching to Tokens retitles the chart', $('#h-spend') && $('#h-spend').textContent === 'Tokens');
    await click('[data-act="measure"][data-val="cost"]'); await wait(500);
    await click('[data-act="model"]'); await wait(200);
    check('clicking a model opens its details inline', !!$('.mdetail') && /Requests/.test($('.mdetail').innerText) && /Cache hit/.test($('.mdetail').innerText));
    check('a selected model is drawn in the chart', !!$('.chart.sel') && !!$('.chart .b-model'));
    await click('[data-act="model"][aria-expanded="true"]'); await wait(200);
    check('clicking it again closes the details', !$('.mdetail'));
    window.scrollTo(0, 400); await wait(200);
    const before = window.scrollY;
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('a background refresh does not move the scroll position', before > 100 && Math.abs(window.scrollY - before) < 5);
    window.scrollTo(0, 0);
    await click('[data-act="tab"][data-val="settings"]');
    await click('[data-act="replace"]');
    const key = $('#mgmt'); key.value = 'sk-or-v1-half-typed'; key.focus();
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('a key being typed survives a background refresh', $('#mgmt') && $('#mgmt').value === 'sk-or-v1-half-typed');
    const mins = $('[data-fk="set:refreshMinutes"]');
    if (mins) { mins.focus(); mins.value = '4'; window.orca.emit('report.changed', { at: Date.now() }); await wait(900); }
    const mins2 = $('[data-fk="set:refreshMinutes"]');
    check('a number being typed survives a background refresh', !!mins2 && mins2.value === '4');
    await click('[data-act="disconnect-ask"]');
    check('Disconnect asks for confirmation first', !!$('[data-act="disconnect-yes"]'));
    await click('[data-act="disconnect-no"]');
    check('cancelling keeps the connection', !$('[data-act="disconnect-yes"]') && /Management key, stored/.test(txt()));
    const toggle = $('[data-set="statusBar"]');
    if (toggle) { toggle.click(); await wait(700); check('the status bar picker is disabled while the status bar is off', !!document.querySelector('select[data-set="statusBarContent"][disabled]')); toggle && $('[data-set="statusBar"]').click(); await wait(500); }
    else check('the status bar toggle exists', false);
  `))
  report(drive('dark', `
    localStorage.clear();
    await click('[data-act="range"][data-val="30d"]'); await click('[data-act="measure"][data-val="cost"]'); await wait(600);
    const over = (el) => el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const bars = () => [...document.querySelectorAll('.chart .hit')];
    check('the chart has a bar for each day', bars().length >= 30);
    const day = bars()[bars().length - 3];
    over(day); await wait(150);
    check('hovering a day shows that day in the readout', /\\d+ models?/.test($('#u-readout').innerText) && !/last 30 days/.test($('#u-readout').innerText));
    check('hovering leaves Models and Token mix alone', /last 30 days/.test($('#h-models').innerText) && /last 30 days/.test($('#h-mix').innerText));
    day.parentNode.querySelector('.hit').dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })); await wait(150);
    check('leaving the chart puts the range back in the readout', /last 30 days/.test($('#u-readout').innerText));
    const boxH = $('#u-models .mbox').offsetHeight;
    bars()[bars().length - 3].dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(250);
    check('clicking a bar selects the day', !!$('[data-act="unpin"]') && !!$('.chart .col.dim'));
    check('clicking a day switches Models and Token mix to it', !/last 30 days/.test($('#h-models').innerText) && !/last 30 days/.test($('#h-mix').innerText));
    check('the Models box keeps its size when the day changes', $('#u-models .mbox').offsetHeight === boxH && boxH > 150);
    over(bars()[2]); await wait(150);
    check('a selected day stays while hovering other bars', !!$('[data-act="unpin"]'));
    $('.chart .hit[tabindex="0"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); await wait(250);
    check('arrow keys move the selection', !!$('[data-act="unpin"]'));
    await click('[data-act="unpin"]');
    check('the chip clears the selection', !$('[data-act="unpin"]') && /last 30 days/.test($('#h-models').innerText));
    const today = bars()[bars().length - 1];
    today.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(250);
    check('today has no per-model split yet and says so', /after the day ends/.test($('#u-models').innerText));
    await click('[data-act="unpin"]');
    check('Token mix and Activity start closed', $('[data-act="toggle"][data-val="mix"]').getAttribute('aria-expanded') === 'false' && !$('#b-mix') && !$('.heat'));
    check('a closed section still shows a one-line summary', /cache hit/.test($('#u-mix').innerText) && /in total/.test($('#heat-ro').innerText));
    await click('[data-act="toggle"][data-val="mix"]');
    check('the arrow opens Token mix', $('[data-act="toggle"][data-val="mix"]').getAttribute('aria-expanded') === 'true' && /Cached prompt/.test($('#b-mix').innerText));
    await click('[data-act="toggle"][data-val="heat"]');
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('open sections stay open after a refresh', !!$('#b-mix') && !!$('.heat'));
    check('the open state is remembered for next time', (JSON.parse(localStorage.getItem('openrouter-usage:prefs') || '{}').open || {}).heat === true);
    const cells = [...document.querySelectorAll('.heat .cell')];
    check('the heatmap covers 26 weeks', cells.length === 182);
    const old = cells[cells.length - 45];
    old.dispatchEvent(new MouseEvent('click', { bubbles: true })); await wait(1200);
    check('a heatmap day outside the range widens it and selects the day', $('[data-act="range"][data-val="all"]').getAttribute('aria-checked') === 'true' && !!$('[data-act="unpin"]') && !!$('.heat .cell.pinned'));
    const warns = () => document.querySelectorAll('.attn').length;
    const n = warns();
    await click('[data-act="dismiss-warn"]');
    check('a warning closes with its X', n > 0 && warns() === n - 1);
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('a closed warning stays closed after a refresh', warns() === n - 1);
    check('warnings have no links', ![...document.querySelectorAll('.attn')].some((w) => w.querySelector('a, [data-act="tab"]')));
  `))
  report(drive('dark,tab=keys', `
    localStorage.clear();
    await click('[data-act="krange"][data-val="30d"]');
    const total = () => ($('.klist') ? $('.klist').parentNode.querySelector('.fine').innerText : '');
    const t30 = total();
    await click('[data-act="krange"][data-val="7d"]');
    check('Keys has its own range switch', /last 7 days/.test($('#h-keys').innerText) && total() !== t30);
    await click('[data-act="krange"][data-val="all"]');
    check('All shows lifetime key spend', /all time/.test($('#h-keys').innerText));
    await click('[data-act="tab"][data-val="usage"]');
    await click('[data-act="range"][data-val="30d"]'); await wait(500);
    await click('[data-act="tab"][data-val="keys"]');
    check('the Keys range is kept apart from Usage', /all time/.test($('#h-keys').innerText));
    await click('[data-act="tab"][data-val="usage"]');
    check('and Usage keeps its own range', $('[data-act="range"][data-val="30d"]').getAttribute('aria-checked') === 'true');
    await click('[data-act="tab"][data-val="keys"]');
    await click('[data-act="inactive"]');
    check('inactive keys expand', /Disabled/.test(txt()));
  `))
  report(drive('dark,many', `
    localStorage.clear();
    await click('[data-act="range"][data-val="30d"]'); await wait(600);
    const box = $('#u-models .mbox');
    check('every model is listed (13), inside a box that scrolls', document.querySelectorAll('[data-act="model"]').length === 13 && box.scrollHeight > box.clientHeight);
    check('the page has no visible scrollbar', getComputedStyle(document.documentElement).scrollbarWidth === 'none');
    box.scrollTop = 120;
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('the Models box keeps its scroll position across a refresh', $('#u-models .mbox').scrollTop > 60);
  `))
  report(drive('dark,setup', `
    const input = $('#mgmt');
    check('setup shows the key form', !!input);
    input.value = 'bad'; await click('[data-act="save-keys"]'); await wait(600);
    check('a rejected key shows its error and stays on setup', !!$('#mgmt') && /rejected|not|invalid|Enter|error/i.test(txt()));
    $('#mgmt').value = 'sk-or-v1-good'; await click('[data-act="save-keys"]'); await wait(1500);
    check('a verified key leads to the dashboard', !!$('[data-act="tab"][data-val="usage"]'));
  `))
  report(drive('dark', `
    let offered = null;
    window.orca.files = { async saveAs(options) { offered = options; return { status: 'saved' }; } };
    const exp = async (kind) => { await click('[data-act="menu"]'); await click('[data-act="export"][data-val="' + kind + '"]'); await wait(700); };
    await exp('daily');
    check('the ⋯ menu exports a daily CSV through the save dialog', offered && /daily/.test(offered.suggestedName) && /spend_usd/.test(offered.data));
    check('a saved CSV reports success', /CSV saved/.test(txt()));
    await exp('models');
    check('the menu can export models', offered && /models/.test(offered.suggestedName));
    window.orca.files.saveAs = async () => ({ status: 'cancelled' });
    await exp('keys');
    check('cancelling the save dialog is not reported as success', /Export cancelled/.test(txt()) && !/CSV saved/.test(txt()));
    window.orca.files.saveAs = async () => { throw new Error('disk unavailable'); };
    await exp('daily');
    check('a save error is visible and exporting can be retried', /Export failed: disk unavailable/.test(txt()) && !$('[data-act="menu"]').disabled);
    await click('[data-act="menu"]');
    document.body.click(); await wait(250);
    check('clicking elsewhere closes the menu', !$('.menu'));
    await document.fonts.ready;
    check('the banner title uses its embedded font', document.fonts.check('600 18px "OR Title"') && getComputedStyle($('.bn-title')).fontFamily.startsWith('"OR Title"'));
    document.documentElement.style.setProperty('--orca-font-sans', 'monospace');
    check('the panel follows Orca font preferences', getComputedStyle(document.body).fontFamily.includes('monospace'));
  `))
  report(drive('dark,tab=settings', `
    const top = () => $('.banner[aria-label="Credits"]').className;
    const preview = () => document.querySelectorAll('.bn-preview');
    check('Settings shows exactly one banner preview', preview().length === 1 && preview()[0].getAttribute('aria-hidden') === 'true' && !preview()[0].querySelector('[data-fk]'));
    check('the banner starts purple and quiet', /\\bc-purple\\b/.test(top()) && !/\\bvivid\\b/.test(top()));
    const colour = $('[data-set="bannerColor"]');
    colour.value = 'gold'; colour.dispatchEvent(new Event('change', { bubbles: true })); await wait(150);
    check('picking a colour restyles the banner and its preview at once', /\\bc-gold\\b/.test(top()) && /\\bc-gold\\b/.test(preview()[0].className));
    $('[data-set="bannerVivid"]').click(); await wait(150);
    check('the Vivid switch makes both vivid', /\\bvivid\\b/.test(top()) && /\\bvivid\\b/.test(preview()[0].className));
    await wait(700);
    window.orca.emit('report.changed', { at: Date.now() }); await wait(900);
    check('the banner choice is saved, not just shown', /\\bc-gold\\b/.test(top()) && /\\bvivid\\b/.test(top()));
    const c2 = $('[data-set="bannerColor"]'); c2.value = 'purple'; c2.dispatchEvent(new Event('change', { bubbles: true })); await wait(700);
    $('[data-set="bannerVivid"]').click(); await wait(700);
    const budget = $('[data-set="monthlyBudgetUsd"]');
    check('Settings has an optional monthly budget', !!budget && +budget.value === 0);
    if (budget) {
      budget.value = '100'; budget.dispatchEvent(new Event('change', { bubbles: true })); await wait(900);
      await click('[data-act="tab"][data-val="usage"]'); await wait(800);
      check('saving a monthly budget shows progress on Usage', !!$('[aria-label="Monthly budget used"]') && /Budget \\$100.00/.test(txt()));
      await click('[data-act="tab"][data-val="settings"]'); await wait(500);
      const input = $('[data-set="monthlyBudgetUsd"]');
      input.value = '0'; input.dispatchEvent(new Event('change', { bubbles: true })); await wait(900);
      await click('[data-act="tab"][data-val="usage"]'); await wait(800);
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
