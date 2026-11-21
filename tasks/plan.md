# OpenRouter Usage 1.1.0

Approved scope: the user requested all maintenance fixes and four proposed features, then publication as 1.1.0.

## Decisions and acceptance criteria

- Correctness: normalize BYOK lifetime/daily/weekly/monthly totals; apply the toggle to Today, month totals, key totals, status bar and budget alerts. Credit runway uses credit spend only. Old cached keys without the new fields continue working.
- Comparisons: compare 7 or 30 completed UTC days with the preceding equal period, including model cost changes. Exclude today. Show unavailable when history does not cover both periods or All is selected. A zero previous total has no percentage; distinguish new spend from no change.
- Export: one CSV for daily totals, models or keys, using the displayed range and BYOK option. Save through Orca's existing files.saveAs from a real click. Quote CSV fields and neutralize spreadsheet formulas in names. Include UTC range dates and approximate-today labels, omit hashes and management keys, and retain unknown key spend as blank.
- Monthly budget: optional USD setting, default 0/off; show spend, budget progress and projection. Notify once per UTC month when actual or projected spend exceeds the limit, re-arm after recovering, and respect notifications off. Never block API usage.
- Key health: read-only badges for expired/expiring within seven days, disabled, exhausted/near limit (at most 10% remaining), and reset period. Use API limit_remaining and include_byok_in_limit semantics; no invented last-use dates.
- Appearance: use Orca font variables with existing fallbacks; preserve narrow layouts, light/dark themes and keyboard access.

## Build order

1. Maintenance and deterministic fixtures (report/worker/tests).
2. Comparisons (report/protocol/panel/mock/checks).
3. CSV export (pure serializer/worker/panel/mock/checks).
4. Monthly budget (manifest/worker/panel/mock/tests).
5. Key health and font integration (normalization/report/panel/mock/tests).
6. Review, screenshots/docs/version, full verification, commit/push/tag, CI, marketplace and installed-copy update.

## Verification

Use `orca plugin test . --json`, `npx -y -p typescript@5.6 tsc -p . --noEmit`, `orca plugin validate . --json` and `node scripts/check-panel.mjs`. New logic gets failing tests before implementation. Exercise CSV save/cancel/failure, comparison/empty states, budget settings/progress and key badges in panel checks. Inspect dark/light/narrow screenshots through Orca's browser. Regenerate listing images with `./scripts/media/render.sh`. Check the public tag, CI and marketplace, then update the existing installed plugin.

## Boundaries and risks

No new dependencies, network endpoints or capabilities. Keep the minimum Orca version at 1.4.248. The panel never receives the management key. Historical activity omits idle days; comparison coverage is conservatively inferred from the earliest stored activity. API-key sums may omit deleted keys and remain approximate. New fields must tolerate existing saved data. Never push the private local master branch.
