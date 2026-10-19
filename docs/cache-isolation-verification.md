# Batch B verification

Scope: #17, stacked on parsing PR #16. Implementation and test results saved; advisor completion review pending. No automatic merge, release, cache persistence or C/D/E UI/state behavior is included.

## Changes

- `readAccounts()` now returns per-provider discovery outcomes and Management-auth status, instead of combining arrays with callbacks.
- Account fallback uses exact nonempty `auth_index` values as opaque IDs. It never matches display labels or list positions and never deduplicates missing IDs by label.
- Successful discovery replaces membership even if all queries fail; removed accounts disappear. Discovery failure or incomplete/malformed discovery preserves previous membership.
- DeepSeek discovery is independent of normal auth-files discovery. DeepSeek-only queries no longer require an unrelated auth-files round trip.
- The Controller fixes the Management source once per operation; URL/key changes isolate caches. Keys never appear in account IDs or returned read results.
- Immutable lifecycle generations, request ownership and pending cancellation prevent obsolete results, counters, notifications and finally blocks from affecting new work.
- Fetch and body reading share the existing 10-second request budget and are abort-aware even when a mock ignores abort. Late rejections are consumed.
- Preserve concurrent account queries and result order. A known Management discovery rejection stops subsequent HTTP; already-in-flight concurrent queries are not promised to be recalled. Provider 401 remains distinct.

## Automated results

| Environment | Tests | Type check | Package check |
| --- | --- | --- | --- |
| Locked SDK `0.80.10` | 102 passed, 0 failed/cancelled | passed | passed |
| Isolated SDK `1.3.0` | 102 passed, 0 failed/cancelled | passed | passed |

The parser baseline had 64 tests. The B suite adds 38 cases across abort/queue primitives, Controller isolation and structured usage discovery. Identity regressions were observed failing before Controller changes; query-layer tests were also written before its implementation. All HTTP tests use synthetic settings and mock fetch. No real account or provider endpoint was contacted.

Additional checks: git diff --check, package allowlist inspection and no runtime dependency/SDK lockfile changes. The added abort helper is packaged; tests and design documentation are not.

## Important assertions

- Reordered same-label accounts, mixed results and renamed metadata reuse only matching IDs.
- A deleted account is removed when discovery succeeds and every remaining account query fails; the last successful timestamp does not advance for all-failed queries.
- Discovery errors/malformed collections preserve membership; successful empty collections remove it.
- Missing/invalid identity cannot reuse quota; a successful unknown response replaces a previous number.
- URL/key changes and inferred provider URL changes cannot reuse another source's cached values.
- resetSettings (the real logout/setup boundary), in-flight disable and shutdown/start abort work and settle pending callers.
- Fetch/body that ignore abort do not block the queue; late rejection does not become unhandled, publish stale data, access expired contexts or clear new-session status.
- A second account query starts while the first is still pending. Mixed auth failure/success remains in discovery order.
- Fixed source/key values cannot change between discovery and quota requests, even if caller-owned inputs mutate.
- Management 401/403 stops unstarted work; provider 401 does not reject the Management credential.

## Bounded terminal replay

The synthetic, network-guarded PTY fixture from the separate compatibility branch was replayed against batch B source copies:

- Pi `0.80.10`, regular: passed.
- Pi `1.3.0`, regular: passed.
- Pi `1.3.0`, fullscreen: passed.

Each run checked a fresh details row after `r`, overlay close/reopen, settings/status, model switches and orderly shutdown, with exactly two discovery and two synthetic quota reads and no unexpected guarded network attempts. Output was drained between operations to avoid stale redraw matches. Orderly process exit alone is not proof of complete timer disposal.

These runs do not cover real credentials/accounts, every terminal, arbitrary widths or every host lifecycle path. C's freshness/status model, D's retry/backoff semantics and E's layout/theme work remain separate batches.
