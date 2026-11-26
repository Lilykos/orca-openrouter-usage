# Changelog

## 1.4.0

- Optional **DeepSeek** balance. Add a DeepSeek API key under Settings → Account, and a DeepSeek card appears on Usage. It shows your balance per currency (topped up and granted), how many days it lasts at your recent rate, and a Top up link. Without a key nothing DeepSeek-related is shown.
- DeepSeek only reports a balance, not usage, so the rate comes from balance readings taken at each refresh over the last 7 days. Top-ups are ignored, and a rate needs about 12 hours of readings.
- Settings → Account lists OpenRouter and DeepSeek by name, each with Test connection, Replace key and Disconnect or Remove. Testing DeepSeek also takes a fresh balance reading.
- Warnings under the banner when the DeepSeek balance is used up, has about 3 days or less left, or the key is rejected.
- The DeepSeek key is verified, stored in Orca's encrypted secrets and only used for `GET https://api.deepseek.com/user/balance`. Removing it forgets the key and every reading.
- The status bar shows only what you spent today (OpenRouter, plus DeepSeek when it is in dollars). Hover it for each account on its own line: balance, today's spend and days left. Click it to show or hide the panel. It turns amber or red when either account runs low. The old "Next to credits" choice is gone.
- DeepSeek's spend today is the drop in its balance since UTC midnight, ignoring top-ups, so it is approximate.
- Fixed: changing a setting right after opening Settings could be undone by the settings loading in.

## 1.3.0

A redesign: one answer first, detail on demand.

- Three tabs instead of five: **Usage**, **Keys** and **Settings**. The Ledger and the separate Models tab are folded into Usage.
- The banner stays, quieter, with the **OpenRouter Usage** title in Outfit, a display font embedded in the panel: credits left, how long they last at your recent rate, and an **Add credits** button.
- Warnings sit under the banner, each with an × to close it: credits running out, keys near or at their limit, keys expiring or expired, and a monthly budget being passed. A closed warning comes back only when something changes, such as a new day or a new month.
- **Usage** leads with Today and this month (with budget progress), then a one-colour daily chart with your 7-day burn drawn over the days it averages. Hover a bar to read that day's total; click it to select the day, and the Models list and Token mix switch to it.
- Spend, Models, Token mix and Activity each sit in a quiet card, so the page reads as a few calm blocks.
- Models sit in a fixed-height box that scrolls inside, with every model listed, so the page does not jump around. Click a model to open its details inline (requests, cost per request, change against the previous period, tokens, cache hit, cost per 1M tokens) and see its share in every bar.
- **Token mix** is now four numbers that follow the range or the selected day: cached prompt, uncached prompt, completion and reasoning, with the cache hit rate and the prompt-to-output ratio.
- Token mix and Activity start closed, each with an arrow to open it and a one-line summary while closed (cache hit, total). What you open stays open.
- The **activity heatmap** covers 26 weeks, follows Cost or Tokens, and selects a day when you click it, widening the range when needed.
- **Keys** follows the same design: a card with its own 7D, 30D and All switch, keys listed like models with their share of spend, badges only when a key needs attention, and an amber limit line when one is near its limit. Click a key for today, this week, this month, all time, its limit, expiry and label. Keys under 1% of the range's spend fold behind a faded button, unless they need attention; inactive keys fold away under an arrow.
- Settings keep the same options, grouped into Account, Appearance, Alerts and budgets, Status bar and Data. CSV export moved to the ⋯ menu.
- The page no longer shows a scrollbar that comes and goes and shifts the layout.
- Choose the banner's **colour** (purple, gold, teal, rose or graphite) and switch **Vivid** on for a bold version, with a half-size live preview beside the controls in Settings. Both are regular plugin settings, so they also appear in Orca's settings. When credits run short, the banner keeps your colour and shows a warning icon; the warnings below it carry the details.
- Follows Orca's light and dark themes for the charts and accents as well as the surfaces.
- No new permissions. Orca may ask you to review the new banner settings when you update.

## 1.2.0

- The daily chart's tooltip now lists every model used that day, largest first, instead of lumping the smaller ones into **Other**. The bars still colour the range's top 5 models; the rest stay grey and keep a grey swatch in the tooltip. A model outside the range's top 5 used to be hidden in Other, even on days it ranked high.
- Hover or focus a day in the **Ledger** to see every model's share of that day, like the chart.
- Today's bar no longer calls its spend "Other": it says "All models (not split yet)", because today's total comes from key totals that are not broken down by model.
- No new permissions or settings.

## 1.1.0

- Compare spend over 7 or 30 completed UTC days with the preceding equal period, including per-model changes. Comparisons wait for sufficient history and handle new spend without infinite percentages.
- Export daily totals, models or API keys as CSV for the selected range and BYOK setting. Files include UTC bounds, label approximate today, leave unknown amounts blank and protect against spreadsheet formula injection.
- Optional monthly budget: Overview progress and an alert when actual or projected spend exceeds the limit. Alerts respect notification settings, recover after spending falls below the limit and reset each UTC month. Usage is never blocked.
- API key health: expiring/expired badges, near/exhausted-limit warnings and reset periods. Limit meters use the API's remaining allowance rather than lifetime usage.
- BYOK totals now follow the setting for Today, monthly figures, lifetime key spend, the status bar and daily-budget alerts. BYOK-only activity is fetched too; external BYOK costs do not shorten OpenRouter credit runway.
- Follow Orca's interface font, with fallbacks for older versions. Retains support for Orca 1.4.248 and the same permissions.
- Make worker fixtures independent of the calendar; add regression checks for the new features, CSV save/cancel/error flows and font preferences.

## 1.0.0

First stable release.

- New **This month** tile on the Overview: spend so far this UTC month (including today) and where it lands at your recent daily rate. It follows your BYOK setting and ignores the range switch.
- Replaces the Reasoning tokens tile, which is still in the token mix and in each model's details drawer.
- More automated checks: the Models list's "Show more / Show less" toggle and the new tile are covered by the panel checks.

## 0.1.0

First release.

- Banner with credits left, projected days left at the recent burn rate, and today's (approximate) spend.
- Tabs: Overview (stat tiles, daily spend or tokens by model, credits today), Models (share bar, ranked list, details drawer, token mix), Keys (spend per API key for 7d, 30d or all time, limits, last use), Ledger (newest-first days, activity calendar) and Settings.
- Settings: management key with verification and connection test, refresh interval, low-balance alert, daily budget, desktop notifications, status bar item and what it shows, BYOK counting.
- Status bar item with credits left and today's spend or days left; turns amber or red as credits run low, and red if OpenRouter rejects the key.
- Refreshes when the panel is opened with stale data; clear messages for offline, revoked-key and no-keyring cases; works for a brand-new account.
- Read-only: the plugin only sends GET requests; the key lives in the OS keyring and never reaches the panel.
