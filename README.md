# OpenRouter Usage

![OpenRouter Usage](images/cover.png)

A sidebar dashboard for [Orca](https://orca.dev) that shows what you spend on [OpenRouter](https://openrouter.ai): credits left, spend, tokens, models and API keys.

Requires Orca 1.4.248 or later and an OpenRouter **management key** (OpenRouter Settings, Management Keys).

## What it shows

- A banner with your **credits left**, the projected days left at your recent burn rate, and today's spend (approximate).
- A **This month** tile with spend so far and where it lands by month end at your recent rate.
- **Spend comparisons** for the last 7 or 30 completed UTC days against the preceding equal period, with per-model changes.
- An optional **monthly budget**, with progress and a warning when actual or projected spend exceeds it. Set it in Settings; 0 turns it off. Alerts never block usage.
- **Key health** badges for expiring/expired keys and near/exhausted limits, with daily, weekly or monthly reset labels. Meters use the remaining API allowance.
- **CSV exports** of daily totals, models or API keys. Pick the data next to Export CSV at the bottom of a report and choose where to save it.
- Five tabs: **Overview** (tiles, daily spend or tokens by model, today's burn), **Models** (ranked, with a details drawer per model plus the token mix), **Keys** (spend per key for 7d, 30d or all time, with limits and last use) **Ledger** (newest-first daily list and an activity heatmap) and **Settings**.
- Range (7d, 30d, All) and Cost or Tokens switches, with refresh on the right.
- A status bar item (`$25.20 left · $0.10 today`) and notifications when credits run low or a daily budget is passed.

## Install

```
orca plugin install Lilykos/orca-openrouter-usage
```

Orca shows what the plugin is allowed to do and asks you to approve it.

## Setup

Open the panel and paste your management key; it is verified with OpenRouter before it is saved. The key is stored in the plugin's encrypted secrets (OS keyring) and never leaves the worker process; the panel never sees it. The Settings tab has: connection test, replace or disconnect the key, refresh interval, low-balance alert, daily budget, notifications, status bar item, and whether BYOK usage counts in spend.

## Data and limits

All numbers come from OpenRouter's `/credits`, `/activity` and `/keys` endpoints; the plugin only ever sends `GET` requests.

- `/activity` covers the last 30 completed UTC days and excludes today. **Today** is computed from per-key totals, so it is approximate. Longer ranges build up from the day you install.
- Per-key spend is fetched separately with `/activity?api_key_hash=…`. Until that fetch succeeds, an unknown amount shows as a dash and exports as a blank cell.
- Comparisons need at least 14 days of history for 7d and 60 days for 30d; All has no comparison. Coverage is conservatively inferred from the earliest stored activity, so accounts with long idle periods may wait longer. Today is excluded from comparisons.
- BYOK follows the setting for spend and budgets. Credit runway always uses OpenRouter credit spend, excluding external BYOK inference costs.
- CSVs use the selected range and BYOK setting and always export USD spend, even in Tokens mode. Daily exports include approximate today; model exports cover completed days; All-time key exports include lifetime usage. UTC bounds and export time are included. Key hashes and the management key are omitted; formula-like names are prefixed with an apostrophe for spreadsheet safety.
- Monthly figures and today's totals are approximate: deleted keys or other workspaces may not be included in key totals. Budgets use UTC months and alert once while over budget, re-arming after recovery or a budget change.

## If something looks wrong

- **"OpenRouter rejected this key"**: the key is mistyped or revoked. Paste a new management key in Settings.
- **"Can't reach OpenRouter"**: you are offline or OpenRouter is down; the plugin keeps the last data and retries.
- **"No secure key store"** (Linux): install a keyring service such as gnome-keyring, then save the key again.
- Days (the Ledger, the daily chart, Today) follow **UTC**; Settings shows when a new day starts for you.

## Develop

```
orca plugin dev watch . --check --shot .orca/shots --json
orca plugin test .          # unit tests (needs the Orca CLI)
node scripts/check-panel.mjs # panel renders, click-through, HTML-injection and image checks (needs Chrome)
./scripts/media/render.sh    # regenerates images/ from scripts/media/*.html
```

## Licence

MIT
