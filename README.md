# OpenRouter Usage

![OpenRouter Usage](images/cover.png)

A sidebar dashboard for [Orca](https://orca.dev) that shows what you spend on [OpenRouter](https://openrouter.ai): credits left, spend, tokens, models and API keys, plus an optional DeepSeek balance.

Requires Orca 1.4.248 or later and an OpenRouter **management key** (OpenRouter Settings, Management Keys).

## What it shows

- The **credits banner** with the **OpenRouter Usage** title, the credits left, how long they last at your recent rate, and an **Add credits** button. Its colour is a setting (purple, gold, teal, rose or graphite) with a **Vivid** switch; Settings shows a half-size live preview.
- **Warnings** under the banner, each closable with an ×: credits running short, keys near or at their limit, keys expiring or expired, a passed monthly budget, and DeepSeek running low, used up or rejected.
- Three tabs: **Usage**, **Keys** and **Settings**.
- **Usage**
  - Today and this month, with an optional monthly budget meter.
  - A one-colour daily chart for 7D, 30D or All, in Cost or Tokens. Hover a bar for that day's total; click a bar or a heatmap day to select it.
  - **Models** in a fixed-height box that scrolls, with each model's share; click a model for its details inline.
  - **Token mix** as four numbers (cached prompt, uncached prompt, completion, reasoning) with the cache hit rate and the prompt-to-output ratio.
  - A 26-week **activity heatmap**.
  - Token mix and Activity are collapsible, closed by default, each with a one-line summary. Selecting a day switches Models and Token mix to it.
- **Keys** has its own 7D, 30D and All switch: each key's share of spend, last use, limit meter, and badges only when something needs attention. Click a key for today, this week, this month, all time, its limit, expiry and label. Keys under 1% of spend fold behind a faded button unless they need attention; inactive keys fold under an arrow.
- **Settings** is grouped into Account, Appearance, Alerts and budgets, Status bar and Data. Account holds OpenRouter and the optional DeepSeek key, each with **Test connection**, **Replace key** and Disconnect or Remove. CSV export is in the ⋯ menu.
- **Optional DeepSeek**: add a DeepSeek API key and a collapsible DeepSeek card appears with its balance, spent today, days left, topped up and granted amounts, and a **Top up** link. DeepSeek's API reports only a balance, so the plugin reads it every refresh; spent today is the drop since midnight UTC and days left use the last 7 days of readings, ignoring top-ups. Without a key the card is hidden.
- A **status bar** item showing only what you spent today (OpenRouter, plus DeepSeek when it is in USD). Its tooltip lists each account's balance and today's spend; clicking it shows or hides the right sidebar. It turns amber or red when credits run low.
- **Notifications** when credits run low or a daily or monthly budget is passed.

## Install

```
orca plugin install Lilykos/orca-openrouter-usage
```

Orca shows what the plugin is allowed to do and asks you to approve it.

Existing marketplace installs update through Orca's marketplace after its catalog indexes the new release. Versions 1.3.0 and 1.4.0 add no capabilities, but Orca may ask you to review what is new: the banner colour and Vivid settings (1.3.0) and the status bar's click action (1.4.0). Your key and settings stay with the existing install.

## Setup

Open the panel and paste your management key; it is verified with OpenRouter before it is saved. The key is stored in Orca's encrypted secrets (OS keyring) and never leaves the worker process; the panel never sees it. Under Settings → Account you can test the connection, replace the key or disconnect it.

A DeepSeek key is optional and added the same way: Settings → Account → DeepSeek, **Add DeepSeek key**. It is verified once, stored in Orca's encrypted secrets and used only to read the balance.

The rest of Settings holds the refresh interval, the low-balance and daily and monthly budget alerts, notifications, whether the status bar shows today's spend, whether BYOK usage counts, and the banner's colour and Vivid switch.

## Data and limits

All numbers come from OpenRouter's `/credits`, `/activity` and `/keys` endpoints; the plugin only ever sends `GET` requests.

- `/activity` covers the last 30 completed UTC days and excludes today. **Today** is computed from per-key totals, so it is approximate. Longer ranges build up from the day you install.
- Per-key spend is fetched separately with `/activity?api_key_hash=…`. Until that fetch succeeds, an unknown amount shows as a dash and exports as a blank cell.
- Comparisons need at least 14 days of history for 7d and 60 days for 30d; All has no comparison. Coverage is conservatively inferred from the earliest stored activity, so accounts with long idle periods may wait longer. Today is excluded from comparisons.
- BYOK follows the setting for spend and budgets. Credit runway always uses OpenRouter credit spend, excluding external BYOK inference costs.
- CSVs use the selected range and BYOK setting and always export USD spend, even in Tokens mode. Daily exports include approximate today; model exports cover completed days; All-time key exports include lifetime usage. UTC bounds and export time are included. Key hashes and the management key are omitted; formula-like names are prefixed with an apostrophe for spreadsheet safety.
- Monthly figures and today's totals are approximate: deleted keys or other workspaces may not be included in key totals. Budgets use UTC months and alert once while over budget, re-arming after recovery or a budget change.

### DeepSeek (optional)

- The DeepSeek key is verified once, stored in Orca's encrypted secrets, and only used for `GET https://api.deepseek.com/user/balance`.
- DeepSeek's API reports a balance, not usage history, so there is no per-model or daily breakdown. The balance is read at every refresh.
- **Spent today** is the drop in the balance since midnight UTC, ignoring top-ups, so it is approximate.
- **Days left** come from balance readings over the last 7 days, ignoring top-ups, and need about 12 hours of readings.
- Removing the key in Settings forgets it and every reading.

## If something looks wrong

- **"OpenRouter rejected this key"**: the key is mistyped or revoked. Paste a new management key in Settings.
- **"DeepSeek rejected this key"**: replace the DeepSeek key under Settings → Account.
- **"Can't reach OpenRouter"**: you are offline or OpenRouter is down; the plugin keeps the last data and retries.
- **"No secure key store"** (Linux): install a keyring service such as gnome-keyring, then save the key again.
- Days (the daily chart, the heatmap, Today) follow **UTC**; Settings shows when a new day starts for you.

## Develop

```
orca plugin dev watch . --check --shot .orca/shots --json
orca plugin test .          # unit tests (needs the Orca CLI)
node scripts/check-panel.mjs # panel renders, click-through, HTML-injection and image checks (needs Chrome)
./scripts/media/render.sh    # regenerates images/ from scripts/media/*.html
```

## Licence

MIT

## Credits

The banner title uses [Outfit](https://github.com/Outfitio/Outfit-Fonts) (Copyright 2021 The Outfit Project Authors), embedded under the SIL Open Font License 1.1 and cut down to the letters it needs.
