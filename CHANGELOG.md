# Changelog

## [0.1.0] - 2026-11-10
### Added
- `checkIme`, `expectSingleSubmit`, `typeWithIme`, `koreanSteps`, `judge` library API.
- Korean (Hangul) composition step generator based on the 2-set keyboard automaton.
- `cdp` driver (Chromium CDP IME commands) and synthetic `chromium` / `firefox` / `safari` profiles.
- CLI: `imeplay demo` and `imeplay check <url | fixture:...>` with `--json`, `--exit-zero`, `--timeout`.
- Mock chat fixtures (`buggy`, `composing-only`, `fixed`) and GitHub Actions matrix (Node 22/24 x Chromium/Firefox/WebKit).
