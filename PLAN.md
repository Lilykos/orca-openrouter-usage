# OpenRouter Usage: Orca plugin plan

A sidebar dashboard for [Orca](https://onorca.dev) that shows what you spend on OpenRouter: credits left, spend, tokens, models, and API keys. It is modelled on the look of **Usage Insights** (`etherll.usage-insights`, installed locally) and borrows the "ledger" ideas of the iOS **AI Token Usage Tracker** app.

Status: v1.1.0 release (https://github.com/Lilykos/orca-openrouter-usage, tag `v1.1.0`, topic `orca-plugin`). Includes spend comparisons, CSV exports, monthly budgets and key health; see `tasks/plan.md` and `CHANGELOG.md`. Install: `orca plugin install Lilykos/orca-openrouter-usage`.

## 1. Decisions so far

| # | Decision | Notes |
|---|---|---|
| 1 | **Management key is required** | Gives access to `/credits`, `/activity`, `/keys`. A regular key alone cannot list keys or read credits. |
| 2 | **Visual target: Usage Insights**, with ideas from the iOS tracker | HTML panel with hand-drawn SVG charts, not the stock components panel. |
| 3 | **Publish when polished** | Private/dev-loaded until then. Repo and catalog work is the last phase. |
| 4 | Regular key **dropped** | It added nothing the management key does not already cover; no field, secret or UI remains. |

Open: I could not identify an app called "Token Ledger". The closest match is *AI Token Usage Tracker* (App Store id 6760191068, an Anthropic-cost tracker). If you meant another app, send its name or a screenshot and I will adjust section 4.

## 2. What Orca lets a plugin do

| Constraint | Consequence |
|---|---|
| Panels are sandboxed with no network | All OpenRouter calls happen in a **`trusted-worker`**; the panel calls it with `orca.plugin.request(name, input)`. |
| `secrets:own` is encrypted by the OS keyring | Both keys live in secrets. Never in `settings` (plaintext) or `storage`. |
| A worker with a status bar item stays running while enabled | The worker can poll and keep a status bar pill current. |
| HTML panels can draw anything (SVG, canvas) | Charts are inline SVG, as in Usage Insights. No chart library needed. |
| Running code needs user approval | Show the user `orca plugin inspect` output; never approve on their behalf. |
| Worker `fetch` is **unverified** | Docs only say panels have no network. Phase 0 proves the worker can reach `openrouter.ai`. |

## 3. Data sources (verified against the OpenRouter docs, 2026-11-10)

Base URL `https://openrouter.ai/api/v1`, header `Authorization: Bearer <key>`.

| Need | Endpoint | Key | Response fields we use |
|---|---|---|---|
| Money available | `GET /credits` | Mgmt | `data.total_credits`, `data.total_usage` (remaining = credits - usage) |
| Spend, tokens, models by day | `GET /activity?date=YYYY-MM-DD` | Mgmt | per row: `date, model, model_permaslug, endpoint_id, provider_name, usage, byok_usage_inference, requests, prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens` |
| Per-key spend and limits | `GET /keys?include_disabled=true&offset=N` | Mgmt | `hash, name, label, disabled, limit, limit_remaining, limit_reset, usage, usage_daily, usage_weekly, usage_monthly, byok_*, created_at, last_used_at, expires_at, workspace_id` |
| Today's spend | derived | Mgmt | sum of `usage_daily` across `/keys` |
| One key's view (optional) | `GET /key` | Any | `is_free_tier`, `free_model_daily_requests{used,limit,remaining}`, `budgets[]`, `effective_budget` |
| Model names and pricing (for cost per 1M tokens) | `GET /models` | none | `id, name, pricing` |

Per-key and per-workspace filters exist: `/activity?api_key_hash=...` and `group_by=workspace`.

Facts that shape the design:

- **`/activity` covers the last 30 completed UTC days and excludes today.** So "today" cannot come from it. We build today from `/keys` `usage_daily`, and an intraday curve from our own snapshots (below).
- **One call returns everything.** `/activity` with no `date` returns all 30 completed days in a single response (214 rows in testing). Finished days never change, so we store them permanently and merge; no per-day fan-out is needed. (`date` still works for a single day.)
- **Ranges:** 7d and 30d are real. "90d / All" are built from our own stored history, so they only grow from install onward. We label that honestly ("since you installed").
- **Pagination:** `/keys` returns up to 100 per page; walk `offset`.
- No documented rate limits, but `/keys` can 429. Back off and keep serving cache.
- The docs say OAuth-created keys are not listed; in testing they **are** listed (named `OAuth: <host>`, so duplicate names are possible: key rows by `hash`).

### Phase 0 findings (verified 2026-11-10 against a real account)

| Question | Result |
|---|---|
| Can a worker `fetch` the network? | **Yes.** `GET /models` from a worker returned 200 with 469 models. |
| `/credits` with a regular key | **Works (200)**, contrary to the docs. The management key is still required for `/activity` and `/keys`. |
| `/activity` with a regular key | 403. |
| `/key` | Works with either key. `is_management_key` tells us which kind it is, so key verification can check it. |
| Today in `/activity` | 400 "Date must be within the last 30 (completed) UTC days". Dates older than the window return 200 with no rows. |
| `/activity` row shape | Has `date` as `"YYYY-MM-DD 00:00:00"`, plus `byok_requests`, which the docs omit. Parse the date by its first 10 characters. |
| `/keys` | Returns every key in the account, including OAuth ones; usage values are lifetime totals per key. |
| Cache tokens | `cached_tokens` is large relative to `prompt_tokens` (heavy prompt caching), so cache hit rate is a worthwhile tile. |
| Many rows per model | The same model appears once per provider/endpoint per day (32 rows for one day), so aggregation by `model` must sum across `endpoint_id`. |

## 4. Product spec: what you see and do

### Layout (top to bottom, like Usage Insights)

1. **Header controls:** range switch `7d | 30d | All`, measure switch `Cost | Tokens`, Filters button (with active-count badge), Refresh icon button, and "Updated 2m ago" using a relative time.
2. **Balance hero** (the headline; from the ledger app): credits remaining as a big number, a `used / purchased` bar, projected **days left** at the current burn rate, and a warning tone when under the threshold.
3. **Tiles:** Spend (range), Today, Tokens in/out, Requests, Avg cost per request, Cache hit rate (`cached_tokens / prompt_tokens`), Reasoning tokens.
4. **Daily spend:** stacked bars per day, stacked by model (top 5 plus "other"). Hover shows the day's breakdown. Today's bar is drawn hatched ("in progress", from the key totals).
5. **Intraday:** a small line of today's credit burn from stored snapshots (ledger app's "intraday").
6. **Models:** ranked bars with cost, tokens in/out/reasoning, requests, cost per request. Click a model to filter everything to it.
7. **Providers:** bars by `provider_name` (OpenRouter routes the same model through different providers, so this is useful).
8. **Keys:** one row per key with usage vs limit, daily/weekly/monthly, last used, disabled badge. Click a key to filter everything to it via `api_key_hash`.
9. **Activity heatmap:** calendar of spend per day (from stored history).
10. **Token mix donut:** prompt (cached / uncached), completion, reasoning.

### Interactions

- Switching range or measure re-draws instantly from cached data; no network.
- Filters popover: Model, Provider, Key, Workspace, "Include BYOK spend" toggle. Reset and Done like Usage Insights. Active filters show as removable chips.
- Click a bar or model to cross-filter; click the chip to clear. (Per-key filtering is deferred: `/activity` rows carry no key hash.)
- **Refresh** forces a refetch of the newest days only; a long-press / menu item does a full rescan.
- Status bar pill (worker): `OR $42.10 left · $1.80 today`. Tone: warning under the threshold, danger under half of it. Click opens the panel.
- Alerts (desktop notification, once per threshold crossing, not per poll): balance low, daily budget exceeded, a key near its limit.
- First run: a setup card with two password inputs (management key, optional regular key), a "Verify" button that calls `/credits` (and `/key`), and a clear error if the key is not a management key.
- Empty, loading (skeleton), stale ("Offline, showing data from 14:02") and error states are all designed, not afterthoughts.
- Light and dark theme, narrow sidebar widths (check 320 px), keyboard focus and `aria` labels, as Usage Insights does.

### Settings (`contributes.settings`)

Refresh interval (default 5 min, min 1), low-balance threshold, daily budget, include BYOK, currency display (USD only in v1).

## 5. Architecture

```
openrouter-usage/                 (own git repo, publishable)
  orca-plugin.json                trusted-worker; capabilities: secrets:own, settings:own,
                                  storage:own, notifications:show; statusBarItems; settings
  src/worker.mjs                  activate(): handlers, poll timer, status bar, alerts
  src/core/openrouter.mjs         fetch client: auth, pagination, 429 backoff, typed errors
  src/core/history.mjs            day cache + snapshot store in orca.storage (versioned, migrated)
  src/core/report.mjs             pure aggregation: range, filters, by model/provider/key/day, burn rate
  src/core/format.mjs             money, tokens, percent
  panel/index.html                the dashboard (HTML + inline SVG), no build step
  tests/                          node:test, mocked fetch, fixtures of real response shapes
  images/                         icon, cover, screenshots (for the catalog)
  README.md  LICENSE  .github/workflows/test.yml
```

Separation of duties:

- **Worker** owns keys, network, cache and alerts. The panel never sees a key. It receives an already-aggregated report.
- **`src/core`** is pure and unit-tested; the worker only wires it up.
- **Panel** asks `report.get({range, filters})` and renders. Cross-filtering recomputes in the worker from cached days, so the panel stays thin.

Worker requests: `status.get`, `keys.save` / `keys.clear` / `keys.verify`, `report.get`, `refresh`. Worker pushes: `report.changed`, `status.changed`.

Storage layout: `days/<YYYY-MM-DD>` (finished days, never refetched), `snapshots` (rolling `{t, total_usage, total_credits}`), `meta` (schema version, last fetch). Bump the schema version with a migration when the shape changes.

## 6. Phases

Each phase ends with something runnable and checked (`orca plugin dev watch --check --shot`, `plugin test`).

0. **Spike (done).** See "Phase 0 findings" in section 3. Still to check in phase 2: whether model slugs map cleanly to `/models` for pricing.
1. **Scaffold (done, stock `worker-panel` template).** Next in this phase: switch the panel entry to HTML, add `secrets:own`, `settings:own`, `notifications:show`, and the licence.
2. **Core, test-first.** `openrouter.mjs`, `history.mjs`, `report.mjs` against fixtures, including pagination, 429, 403 (wrong key type), empty days, partial failure.
3. **Worker.** Handlers, poll timer, snapshots, status bar, alerts.
4. **Panel v1.** Setup card, balance hero, tiles, daily bars, models, keys. Check screenshots in light and dark at narrow width.
5. **Panel v2.** Filters and chips, cross-filtering, provider and intraday charts, heatmap, donut.
6. **Polish.** Skeleton and stale states, accessibility, a performance pass on large histories, README.
7. **Ship.** `plugin validate` and `inspect`, cover and screenshots, version, tag, `orca-plugin` topic, catalog entry via `orca plugin release-entry`. Only when you say go.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Management key can create and delete keys | Plugin only issues `GET`s, and the code is structured so a non-GET is impossible (client exposes only `get`). State this in the README and the approval screen. |
| Key leakage | Secrets store only; never logged, never sent to the panel, masked in the UI, excluded from errors. |
| API fields change | Parse defensively; unknown or missing fields degrade to "n/a" rather than a crash. |
| 30 calls on first load | Concurrency limit, progressive rendering as days arrive, permanent cache of finished days. |
| History shorter than 90d | Label ranges honestly; history accumulates from install. |
| Worker restarts lose memory | Everything that must survive lives in `orca.storage`. |
| "Today" is approximate | Hatched bar plus tooltip explaining the source (key totals). |
| OpenRouter or ledger-app naming confusion | Our own branding and icon; no OpenRouter logo use without checking their brand terms before publishing. |

## 8. Out of scope for v1

Per-Orca-workspace attribution (OpenRouter does not know which workspace called it; a later idea is to map keys to projects), multi-account, non-USD currencies, widgets, editing or creating keys from the plugin.
