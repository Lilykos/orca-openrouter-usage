# OpenRouter Usage

![OpenRouter Usage](images/cover.png)

A sidebar dashboard for [Orca](https://onorca.dev) that shows what you spend on [OpenRouter](https://openrouter.ai): credits left, spend, tokens, models and API keys.

Requires Orca 1.4.248 or later and an OpenRouter **management key** (OpenRouter Settings, Management Keys).

## What it shows

- A banner with your **credits left**, the projected days left at your recent burn rate, and today's spend (approximate).
- Five tabs: **Overview** (tiles, daily spend or tokens by model, today's burn), **Models** (ranked, with a details drawer per model plus the token mix), **Keys** (spend per key for 7d, 30d or all time, with limits and last use) **Ledger** (newest-first daily list and an activity heatmap) and **Settings**.
- Range (7d, 30d, All) and Cost or Tokens switches, with refresh on the right.
- A status bar item (`$25.20 left · $0.10 today`) and notifications when credits run low or a daily budget is passed.

## Setup

Open the panel and paste your management key; it is verified with OpenRouter before it is saved. The key is stored in the plugin's encrypted secrets (OS keyring) and never leaves the worker process; the panel never sees it. The Settings tab has: connection test, replace or disconnect the key, refresh interval, low-balance alert, daily budget, notifications, status bar item, and whether BYOK usage counts in spend.

## Data and limits

All numbers come from OpenRouter's `/credits`, `/activity` and `/keys` endpoints; the plugin only ever sends `GET` requests.

- `/activity` covers the last 30 completed UTC days and excludes today. **Today** is computed from per-key totals, so it is approximate. Longer ranges build up from the day you install.
- Per-key breakdowns of spend are not available because `/activity` rows carry no key.

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
