# Changelog

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
