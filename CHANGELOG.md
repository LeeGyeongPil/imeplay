# Changelog

## [0.2.2] - 2026-11-26
### Changed
- `imeplay check` with `--profiles auto` (the default) on a `contenteditable` (non-textarea/input) field now judges by `cdp` only and prints the synthetic profiles as `SKIP`. JSON output gains a top-level `skipped: [{ profile, reason }]` array (empty when nothing was skipped); `reports` is unchanged.
- Choosing a synthetic profile explicitly on such a field still exits 2, now with a `use --profiles cdp (Chromium) for contenteditable inputs` hint. In Firefox/WebKit, where no profile can run, `auto` exits 2 with the same hint.

## [0.2.1] - 2026-11-18
### Fixed
- Install docs pin `playwright` to the same version as `@playwright/test`, and the browser-launch error now shows the playwright version imeplay loaded, so `npx playwright install` fetches the browser revision the CLI needs.

## [0.2.0] - 2026-11-11
### Added
- `imeplay check --steps FILE`: JSON array of IME steps (compose/commit/insert) so Japanese, Chinese and other non-Hangul compositions can be checked from the CLI. Cannot be combined with `--text`.

## [0.1.0] - 2026-11-10
### Added
- `checkIme`, `expectSingleSubmit`, `typeWithIme`, `koreanSteps`, `judge` library API.
- Korean (Hangul) composition step generator based on the 2-set keyboard automaton.
- `cdp` driver (Chromium CDP IME commands) and synthetic `chromium` / `firefox` / `safari` profiles.
- CLI: `imeplay demo` and `imeplay check <url | fixture:...>` with `--json`, `--exit-zero`, `--timeout`.
- Mock chat fixtures (`buggy`, `composing-only`, `fixed`) and GitHub Actions matrix (Node 22/24 x Chromium/Firefox/WebKit).
