# Changelog

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
