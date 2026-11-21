# Release 1.1.0

- [x] BYOK totals, credit runway, deterministic worker fixtures; regression tests pass.
- [x] Equal-period comparisons and model changes; history and zero-baseline cases verified.
- [x] Safe CSV exports and save/cancel/error panel flows verified.
- [x] Optional monthly budgets, progress and deduplicated alerts verified.
- [x] Key health badges and Orca fonts verified.
- [x] Review all changes; check light/dark/narrow layouts; regenerate listing screenshots.
- [x] Update documentation and version; unit, type, validation and panel checks pass.
- [x] Push main and v1.1.0; verify CI and the public release (both runs passed; a fresh public clone validates).
- [ ] Update the installed marketplace copy when the catalog offers 1.1.0. It still offers 1.0.0; Orca refuses replacing a marketplace install with a Git URL. Keep the existing key/settings intact and use `orca plugin update lilykos.openrouter-usage --json`. The monthly-budget setting triggers update review, already authorized by the user's request for this release.
