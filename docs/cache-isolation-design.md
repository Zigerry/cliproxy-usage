# Batch B: cache identity and operation isolation

Reviewed implementation design; required cancellation/discovery corrections applied. Tracks #17; stacked on parsing PR #16. This batch does not implement C's freshness snapshot, D's backoff or E's UI redesign.

## 1. Minimal result types

```ts
// src/types.ts: presentation data; accountId is opaque and never rendered.
type AccountUsage = {
  provider: ProviderName;
  accountId?: string; // nonempty auth_index only, never email/label/credentials
  label: string;
  windows: UsageWindow[];
  balance?: AccountBalance;
  error?: string;
};

type ProviderReadResult =
  | { provider: ProviderName; discovery: "success"; items: AccountUsage[] }
  | { provider: ProviderName; discovery: "failure"; error: string };

type ReadAccountsResult = {
  providers: ProviderReadResult[];
  managementAuthFailed: boolean;
};
```

`readAccounts()` returns this result instead of an array plus callbacks. Remove `onProviderFailure` / `onManagementAuthFailure` to avoid two authoritative paths. A successful provider result includes all currently discovered accounts, including failed account query objects. Normal empty discovery is success with items=[].

Options add `signal?: AbortSignal` and an optional pre-resolved `ManagementSource`. Controller resolves that source once and passes it to the read call. Direct standalone callers can still resolve via the existing providerConfigPath option. The result never includes the Management key.

- `auth_index` must be a nonempty string to become accountId. It is an opaque, exact value, not a token.
- Deduplicate valid identities by provider + accountId only. Missing identities are not deduplicated by label/name or reused across reads.
- Unavailable accounts with an ID still belong to successful discovery and return a failed query item.
- Preserve the existing concurrent account-query behavior with Promise.all and stable discovery order; do not introduce serial scheduling or a concurrency pool. Management 401/403 during discovery prevents subsequent stages. A rejection learned during concurrent queries marks managementAuthFailed and prevents unstarted work, but does not promise to retract requests already in flight. Official provider 401 is not Management auth rejection.
- DeepSeek success/failure is expressed independently from other provider discovery; do not equate failed openai-compatibility with an empty collection. Malformed discovery lists or structurally invalid entries fail closed rather than authoritatively deleting caches: if collection completeness is uncertain, report discovery failure. Missing/invalid auth_index alone is not proof an account disappeared; keep the discovered entry without a reliable ID, and do not reuse its old data.

## 2. Collection and fallback rules

Controller keeps the existing session caches, error maps and formatting. Add only account identity and source/operation ownership.

- A source boundary is effective normalized Management URL + the locally held Management key. Compare in memory; never serialize or publish the key or a key-derived ID.
- Source/credential changes clear all account caches and rejected-auth state before publishing new-source results. Automatic provider config file changes receive the same treatment.
- Discovery failure records provider error and preserves its previous collection.
- Discovery success replaces the collection even when all account queries failed. Only entries present in the new collection can be retained.
- For each failed query, reuse old successful quota/balance only when both account IDs exist and match within the same provider/source boundary. Use the newly discovered label/identity with the cached data; keep errors in the existing provider refresh error map. Never fall back by label, list position or account name.
- A successful unknown response replaces old data with unknown, not a successful-looking cached number. Freshness timestamps are deferred to C, except do not update the existing provider success time when all queries failed.

## 3. Operation ownership and cancellation

Use one monotonic generation, one active operation and existing CoalescingAsyncQueue. No new scheduler or runtime dependency.

- Refresh requests capture generation at submission. Same-generation requests coalesce as today; cross-generation merges take only the new request. Old force, providers, loaded settings and notification requests must not migrate.
- Track current-generation request tokens (or equivalent ownership) instead of unscoped refresh counters. `providerIsRefreshing` includes the valid active operation and pending requests. Old finally cannot decrement new work.
- Minimal queue API `cancelPending()` resolves canceled waiters and removes the pending value. Running work finishes via the abort race described below.
- `start`, `shutdown`, `resetSettings`, source/key changes and provider disable invalidate affected work before state changes. A global generation invalidation on disable is acceptable; unaffected provider caches remain session-local.
- Each running operation owns AbortController + captured generation. Side effects require active controller, matching generation, nonaborted signal and operation ownership.
- Resolve settings and ManagementSource inside the owned operation, checking ownership after each await. Fix the source before HTTP. Keep the captured lifecycle generation immutable. Automatic source changes are handled as a separate cache boundary: clear old-source caches and obsolete pending work before querying the fixed new source. The one valid active operation retains its generation/ownership; canceled older tasks cannot publish because they no longer own the active operation. Explicit reset/apply/disable/start/shutdown still advance lifecycle generation and abort active work. No running operation transfers generation.
- `applySettings`/`syncSettings` cannot overwrite credential/source/provider settings while old work remains valid. `resetSettings` is the real logout/setup boundary; index.ts may pass ctx into syncSettings for immediate repaint on invalidation.
- Wrap the complete running async task with an abort-aware promise race. It must promptly release the queue even if fetch or body ignores abort. The original task remains handled; every later await/catch is guarded so late resolve/reject cannot publish.
- Propagate the signal through discovery fetches, quota fetches and body reads; combine with existing 10s per-request timeout. Race both fetch and response.json() against the combined signal; a header response must not end the timeout budget. Recheck cancellation before starting each next network stage. Consume late rejections even when the underlying fetch/body ignores abort.
- No cancellation notification or provider error is emitted. Only current operation can clear its own status in finally. Captured contexts are never accessed after losing ownership.
- Normal model/provider switching may preserve caches within the same source. Rendering still follows the active model, whose SDK getter is dynamic.

## 4. Implementation boundaries

- `src/types.ts`: optional accountId and explicit read result types.
- `src/usage.ts`: discovery/query result construction, one-source option, abort/timeout propagation and safe response reading.
- Optional tiny `src/abort.ts`: dependency-free race helper that removes listeners, consumes late rejection and handles already-aborted signals.
- `src/refresh.ts`: cancelPending only; preserve serial coalescing semantics.
- `src/controller.ts`: identity fallback, source boundary, generation and guarded effects. No snapshot/UI rewrite.
- `index.ts`: lifecycle/command wiring only if syncSettings needs current ctx.
- Tests: update existing readAccounts assertions to new structured result, then add focused read/discovery, queue and Controller race tests. No provider network calls or user configuration.

## 5. Test-first matrix

B1:

1. Same label/different IDs, reordered discovery with mixed success/failure: only matching account data reused; changed label reflected.
2. Discovery succeeds, an account is removed, all remaining queries fail: removed account disappears, remaining matching account falls back.
3. Discovery itself fails: previous collection remains with error.
4. Missing/invalid IDs: no label-based deduplication or fallback.
5. DeepSeek discovery failure is independent; normal empty success removes its old accounts.
6. URL/key changes (including inferred URL file changes) cannot reuse old-source cache; resolved source is not reread mid-refresh.

B2:

7. Deferred discovery, quota fetch and body promises across actual resetSettings/logout; abort signal fires and result cannot repaint or notify.
8. Disable provider and shutdown/start while in flight; no old counters, status, auth rejection or error leaks into new generation.
9. Obsolete pending request with old loaded settings/force never performs HTTP; waiters finish.
10. Mock ignores abort or rejects late: new generation can refresh before old promise completes; no unhandled rejection or old finally clearing new status.
11. Queue still coalesces same-generation requests and survives failures; cancellation removes only pending work.
12. Response abort/timeout affects body reading as well as initial headers; no next-stage HTTP after cancellation.
13. A second account query starts while the first remains pending; mixed rejection/success retains the full collection in discovery order. Management discovery rejection prevents all subsequent HTTP; concurrent query rejection does not assert that already-started requests can be recalled.

Run locked SDK and Pi 1.3.0 tests/type checks, package allowlist checks and git diff --check. Save results before advisor completion review. Make B1 and B2 focused commits in one clearly dependent PR with Closes #17; no automatic merge or release.
