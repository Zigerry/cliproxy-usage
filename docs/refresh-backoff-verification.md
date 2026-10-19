# Batch D verification

Issue #21, stacked on C PR #20 (`feat/19-usage-state`). Implementation and results saved; advisor completion review pending. No merge, release, version/SDK upgrade or E layout/theme options are included.

## Behavior implemented

- Safe structured failure facts distinguish outer Management from nested provider HTTP failures. Only scope/category/status/absolute Retry-After are retained; response bodies, arbitrary headers and network error fragments are not stored.
- Strict nonnegative integer delta-seconds and three HTTP-date syntaxes, calendar/weekday validation, response-specific timestamps, and overflow-safe long-wait saturation. Future Retry-After on any failed HTTP result is respected, including 503 and auth failures; local backoff never caps a server wait.
- One source-level retry record and optional retry facts in each existing provider record. Actual temporary failures increment once per round, including partial success. Clean actual outcomes reset only the corresponding local streak; successful unknown quota does not imply valid data.
- Source-level temporary backoff also covers no-header Management 429 across provider switches. Any Management 429/auth rejection/future server wait stops unstarted same-round work; ordinary 503 without server wait still allows independent discovery. Already-started account queries remain concurrent and in discovery order.
- Skipped work is not another actual failure. Skipped discovery preserves pre-begin discovery/account results and all their data/attempt times; the shared source constraint is exposed separately. Inherited unqueried account errors do not increment provider retry counters.
- One eligibility gate at queue execution, after source adoption and before provider attempts. Repeated blocked calls settle without provider HTTP, attempt changes, streak growth or waiting queues. Force bypasses local backoff, never server wait. A pending force is checked against newly received limits.
- Source/key/reset/start/shutdown clear old policy. Model switches and provider disable/re-enable cannot erase live server waits; disabling removes account data but retains that provider's server-only record.
- Existing periodic checks remain the only automatic HTTP scheduler. Snapshot metadata separates earliest automatic request, earliest manual request and next actual periodic check. A check may precede eligibility; no timestamp promises an HTTP request. Configuration/auth/unsupported/disabled contexts do not advertise automatic plans.
- C's single expiry timeout also repaints policy deadlines, segmented to Node's timeout limit. Expiry/long-wait callbacks only repaint; old context ownership is discarded. No per-provider retry timers, persistent history or dependencies added.

## Red-first evidence

- Initial HTTP tests reproduced missing helpers and missing safe metadata before implementation (23 failures out of 24 initial tests). Focused coverage was expanded after implementation.
- Pure retry/state tests ran before their implementation; initial failure evidence was saved.
- All 10 initial Controller eligibility regressions failed before Controller integration.
- Targeted follow-up review found the no-header 429/unstarted-discovery and skipped-discovery timestamp gaps. Six focused regressions failed before those fixes, including cached provider and pure-state assertions.
- A further failing metadata regression ensures rejected Management access is accurately shown as force-revalidatable, while notification alone does not bypass rejection.
- B/C tests retain their original cache/isolation assertions; immediate retries that intentionally test state transitions now explicitly force local-backoff bypass. The bounded details test also inspects the scrolled second account rather than dropping its cached-quota assertion.

## Validation

| Environment | Tests | Types | Package |
| --- | --- | --- | --- |
| Locked SDK `0.80.10` | 236 passed, 0 failed/cancelled | passed | passed |
| Isolated SDK `1.3.0` | 236 passed, 0 failed/cancelled | passed | passed |

The HTTP/policy core commit was independently verified from its staged tree: 220 tests and types passed. Final packages contain 18 allowlisted files including the two new pure modules; no tests/design reports are shipped. git diff --check passes; package.json, package-lock.json and runtime dependencies are unchanged.

These SDK rows are **local** verification. The inherited remote CI is checked separately; the two-SDK CI matrix remains in unmerged compatibility PR #15.

Deterministic tests cover two-layer 401/429/503, safe malformed nested headers, strict/past/zero/invalid/huge Retry-After, maximum concurrent deadlines and response-time independence, source/provider scope, partial rounds, cap/reset, actual vs skipped failures, pending/repeated force, source changes, late cancellation, disable/re-enable, periodic-plan separation, very long repaint segmentation and expired-context cleanup. Tests use only synthetic configuration and mock fetch; no real provider or user credentials.

## Bounded terminal replay

The disposable synthetic network-guarded fixture from the separate compatibility branch passed against D source in three runs:

- `0.80.10` regular.
- `1.3.0` regular.
- `1.3.0` fullscreen.

Each run required fresh details output after r, close/reopen, settings/status, model switch and orderly exit (code 0), with exactly two synthetic quota reads and no unexpected guarded network attempts. No fixture or SDK dependency was added to this feature branch.

PTY coverage validates ordinary successful interactions and metadata rendering, **not** real quota-window waits or live provider rate limits. Rate-limit/backoff behavior is covered by deterministic HTTP/fake-clock tests. This is not a guarantee for every terminal, real provider schema, every lifecycle path or complete host resource disposal. Backoff is a simple round/provider/source policy, not an account scheduler; periodic checks can be later than the eligibility deadline.
