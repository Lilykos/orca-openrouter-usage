# Changelog

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
