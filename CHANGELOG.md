# Changelog

## 0.1.0

First release.

- Banner with credits left, projected days left at the recent burn rate, and today's (approximate) spend.
- Tabs: Overview (stat tiles, daily spend or tokens by model, credits today), Models (share bar, ranked list, details drawer, token mix), Keys (spend per API key for 7d, 30d or all time, limits, last use), Ledger (newest-first days, activity calendar) and Settings.
- Settings: management key with verification and connection test, refresh interval, low-balance alert, daily budget, desktop notifications, status bar item and what it shows, BYOK counting.
- Status bar item with credits left and today's spend or days left; turns amber or red as credits run low, and red if OpenRouter rejects the key.
- Refreshes when the panel is opened with stale data; clear messages for offline, revoked-key and no-keyring cases; works for a brand-new account.
- Read-only: the plugin only sends GET requests; the key lives in the OS keyring and never reaches the panel.
