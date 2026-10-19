# Batch C verification

Scope: #19, stacked on B PR #18. Implementation and results saved; advisor completion review pending. Retry/backoff (D), appearance/layout options (E), merging and release remain out of scope.

## Implementation

- One provider state Map replaces the parallel item/fetched/time/error stores. Shared pure reducers and detached readonly snapshots are the authority for widget, details, status and notifications.
- Account latest outcome, actual-query attempt round and last-valid data time are independent. Skipped/unavailable/missing-ID accounts do not acquire fictitious query timestamps.
- Partial success advances only valid account data times; provider complete-success time advances only on an all-valid or successful empty round.
- Successful unknown data hides historical numbers. Failed queries/discovery may show explicit cached/stale data. Missing data is not assumed full quota; real zero quota/balance and finite negative balances remain valid.
- Discovery failure preserves prior account query facts. Stale describes displayed values, not an empty setup/error state with no data. Reset/age expiry never changes the quota or timestamps.
- Typed configuration facts distinguish pending setup, missing key/URL, invalid source and Management rejection; provider HTTP 401 is not a setup classification.
- DeepSeek valid objects without usable balance values are unknown; malformed containers/entries are response errors. Raw JSON parse fragments and free-form unavailable-account text are not exposed.
- Preserve B's opaque ID matching, source/generation isolation, concurrent reads and cancellation. Snapshot sanitization does not trim or truncate stable IDs.
- Details pin state/errors above the scroll body and close on provider/source/login/session invalidation instead of freezing.
- One Controller expiry timeout only repaints. A separate existing 30s details redraw still only reads a snapshot. Neither starts HTTP.

## Automated checks

| Environment | Full suite | Type check | Package check |
| --- | --- | --- | --- |
| Locked SDK `0.80.10` | 154 passed, 0 failed/cancelled | passed | passed |
| Isolated SDK `1.3.0` | 154 passed, 0 failed/cancelled | passed | passed |

The pure-state commit was independently checked in an isolated checkout (120 tests and types passed). The subsequent read-outcome commit was independently checked (124 tests and types passed). The final integrated suite includes the B cancellation/isolation regressions and the C state/view/timer tests.

New regression tests were run before the corresponding pure/Controller implementations. The read-level C tests were also replayed against the B baseline, reproducing failures before validating the C changes. All network-facing tests use synthetic configuration and mocked fetch.

Checks include git diff --check, unchanged package/lockfile/runtime dependencies, and package allowlist verification (test and design files excluded).

## State and integration assertions

- Complete account-result matrix: valid+error/unknown is ready+partial; unknown+error is error+partial; all unknown is unknown; all error remains error with optional cached data; normal empty discovery is empty.
- Loading only without a prior result; background refresh retains existing data and error facts.
- Last actual account attempt does not advance after discovery failure or skipped HTTP, and last complete success does not advance after a partial/unknown/error round.
- Input and output alias isolation includes window/amount arrays, prior records, configuration and Date.setTime().
- Unknown hides old data, while subsequent failure can use explicitly historical cached data; unknown is never a fake 100% value.
- Missing/rejected configuration is typed; status reads configuration but does not issue provider requests or invent a retry gate.
- Fake Date/setTimeout tests prove age/reset expiry repaints with no HTTP or timestamp mutation, with no past-deadline loop. Interval changes immediately recompute freshness; model/reset/disable/shutdown drop old repaint ownership and cannot access expired contexts.
- Widget/details/status/notifications share state and cache annotations. Pinned cached/error markers remain visible during account scrolling, including bounded very short terminal layouts.
- Known credentials and terminal controls are filtered from public state; malformed remote JSON fragments are not included in error output.

## Bounded PTY replay

The synthetic network-guarded fixture from the separate compatibility branch was replayed against C source copies:

- Pi `0.80.10` regular: passed.
- Pi `1.3.0` regular: passed.
- Pi `1.3.0` fullscreen: passed.

Each run asserted new details output after r, close/reopen, settings/status, provider/model switches and orderly shutdown. Each made exactly two synthetic discovery/quota reads and recorded no unexpected guarded network attempts. The driver drains buffered output between stages. No real account credentials/provider requests were used.

This is not a proof of every terminal, real provider schema, every host lifecycle path or total timer-resource disposal. C's one-shot timer behavior is covered by deterministic unit/integration tests, not by waiting for real quota windows in a terminal. D's server Retry-After and backoff behavior is not implemented or claimed here.
