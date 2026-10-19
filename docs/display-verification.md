# Batch E verification

Issue #23, stacked on D PR #22 (`feat/21-refresh-backoff`). Implementation and verification saved; advisor completion review pending. No merge, release, version/SDK upgrade or new runtime dependency.

## Independent commits

- E1 `a861275`: shared width-aware quota/balance/identity/prose layout helpers; full locked-SDK suite 251/251 and types passed before commit.
- E2 `fbff7d8`: host theme for every provider, with remaining-quota thresholds unchanged; full suite 253/253 and types passed before commit.
- E3 `b665231`: showWidget settings, Controller visibility/revision handling, status and documentation; full suite 267/267 and types passed before commit.

E1 keeps complete window+remaining fields and amount/sign/currency units, shortens names/decorations first, splits rows and explicitly omits unrepresentable fields. Multiline accounts retain distinct identities; cached/stale/error warnings remain visible at ordinary narrow widths. Details compute inner width before layout and bound scrolling after resize. Ambiguous shared currency symbols gain codes. No raw terminal instructions are admitted through the existing sanitized snapshot boundary.

E2 removes the fixed Claude ANSI brand color. Both same widget and same details instances are tested across a changing light/dark callback palette plus invalidate, with no old ANSI remaining. Token thresholds stay success at 30% or more, warning below 30%, error below 10%.

E3 defaults showWidget to true for missing/legacy settings; only literal booleans are accepted. It uses existing unknown-field preservation, private permissions and atomic saves, with real keyboard-driven SettingsList success/failure rollback tests. A pure visibility toggle does not create/re-anchor periodic checks, issue provider HTTP, cancel a request, change lifecycle generation, clear cache/cooldowns or close details. Hidden widgets drop their expiry timer; details and the existing refresh policy continue. A minimal display revision pairs queued loaded settings with their observation and prevents paused/old reads overriding the latest toggle; later fresh reads still accept external edits. Combined real source/provider changes retain their own invalidation/server-wait boundaries.

## Red-first and regression coverage

- E1 narrow-field regressions were run before layout implementation. Focused coverage expanded to 13 tests, including empty/sanitized labels and 1..5-column error-only fields.
- E2's widget theme regression failed first; the existing details stateless renderer already repainted correctly and remains covered.
- Settings-only isolated tests reproduced six failures before implementation; real Controller visibility tests all five initially failed before integration. Follow-up coverage includes eight Controller cases.
- Deterministic cases cover 30/40/80/120 columns, extreme widths, Chinese/emoji/combining labels, zero/full quota, zero/negative/multiple-currency balance, ANSI wrappers, control removal, cached failures, scrolling/resize, private saves and cleanup, periodic anchor stability, hidden expiry cleanup, hidden HTTP continuation, in-flight ownership, rapid toggles, old queued loaded snapshots merged with new requests, paused read-only status, later external edits, D's server gate and real configuration changes.
- Actual synthetic rendered text is saved at `test/fixtures/display-layout.txt` and compared by the renderer tests. Regenerate explicitly with `UPDATE_LAYOUT_FIXTURES=1 node --import tsx --test test/layout.test.ts`. No image generation or real account data is needed.

## Final SDK and package checks

| Environment | Full suite | Types | Package |
| --- | --- | --- | --- |
| Locked SDK `0.80.10` | 267 passed, 0 failed/cancelled | passed | passed |
| Isolated SDK `1.3.0` | 267 passed, 0 failed/cancelled | passed | passed |

Both packages contain 18 allowlisted files; tests, snapshots, replay patch and design reports are excluded. package.json/package-lock.json, runtime dependencies and version remain unchanged; git diff --check passes. The matrix above is local verification, not remote CI: compatibility PR #15 remains separate/unmerged. The inherited remote workflow will be checked separately.

## Finite terminal replay

Network-guarded disposable runs passed on `0.80.10` regular, `1.3.0` regular and `1.3.0` fullscreen. Each asserts:

- Initial quota and fresh details row after r, close/reopen, settings/status and model/provider switching.
- Public host light/dark theme changes, with different semantic success paint returned by the host; same-instance repaint behavior is additionally unit-tested.
- Real SettingsList widget disable, hidden status, hidden cached details and r updating quota to a new value.
- Live resize to 30 and 40 columns retaining both complete 7d/5h remaining fields; restore size and close.
- Real SettingsList enable and immediate cached widget paint, with exactly three total synthetic discovery/quota reads (initial, visible r, hidden r); toggles/theme/resize themselves add none.
- Normal exit code 0 and zero unexpected guarded network attempts; no real provider or user credentials.

Initial driver attempts incorrectly waited for an unchanged status prefix or for a widget row only after closing settings. The host emits diff-only updates and can paint the widget while settings is still open. The corrected driver drains old output, checks provider on the first status, checks the changed visibility suffix on the final status, and accepts the two fresh enable/paint outputs in either order. No product code was changed to force redraws or extra HTTP to satisfy these assertions. All three runs then passed with the same corrected driver.

### Reproduce the enhanced fixture

`test/compatibility/display-smoke.patch` applies to the three fixture files from compatibility PR #15, branch commit `aedc9d8cbd1c36923cfafb8f1bd4ada4dcfc7b8b`. It includes the fresh-output driver changes and E's additional checks, rather than copying unrelated compatibility implementation into this feature branch.

Extract those fixture files into a disposable directory under their `test/compatibility/` paths, apply the patch with git apply, and prepare separate disposable `baseline`/`current` copies of E with the respective SDK dependencies installed. Then run:

```sh
python3 test/compatibility/smoke.py baseline regular /path/to/disposable-workspace
python3 test/compatibility/smoke.py current regular /path/to/disposable-workspace
python3 test/compatibility/smoke.py current fullscreen /path/to/disposable-workspace
```

The driver requires Python pexpect, uses isolated agent, home and working directories, and refuses using the fixture's own checkout as the project under test. Patch application, Python syntax and exact equality of the patched files with the three actually replayed fixtures were verified. Do not run fixtures against personal configuration or real provider accounts.

This coverage is finite: not every terminal/font/Unicode sequence, live provider schema, every lifecycle path or complete host resource disposal. Very narrow/short views may only show explicit omissions/status/exit hints; no claim that all fields fit every terminal. This batch changes presentation, not D's scheduler, HTTP policy or account routing.
