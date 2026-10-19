# Batch C: shared usage state and account freshness

Reviewed design with required state/time/alias/lifecycle corrections applied. Tracks #19, stacked on B PR #18. No D retry/backoff changes, E layout/theme options, new dependency or persistent usage history.

## 1. One authoritative container

Replace Controller's latestItems/fetchedProviders/lastUpdated/lastRefreshErrors with one `Map<ProviderName, ProviderUsageState>`. B's generation, active operation, pending ownership, source boundary and rejected-auth guard stay intact. No stored snapshot cache or parallel timestamp maps.

Proposed facts (`src/types.ts` / pure `src/state.ts`):

```ts
type UsageData = { windows: UsageWindow[]; balance?: AccountBalance };
type AccountUsageState = {
  provider: ProviderName; accountId?: string; label: string;
  attemptedAt?: number; // most recent actual query's refresh-round start
  queried: boolean; // whether the latest outcome actually attempted HTTP
  result: "valid" | "unknown" | "error";
  error?: string;
  valid?: { at: number; data: UsageData };
};
type ProviderUsageState = {
  provider: ProviderName;
  accounts: AccountUsageState[];
  lastAttemptAt?: number;
  discovery?: { result: "success" | "error"; at: number; error?: string };
  lastCompleteSuccessAt?: number;
};
```

All times are epoch milliseconds. At an actual read start Controller records the provider attempt time; the reducer receives `{ attemptedAt, completedAt }`. Read-layer account outcomes add an explicit queried fact. Account attemptedAt advances only when queried=true, and is that query's refresh-round start (not its exact outbound HTTP start). Unavailable/missing-ID/auth-interrupted entries keep prior actual query time or none, with queried=false; views cannot describe them as newly failed HTTP requests. Valid data timestamps and discovery/result times use completedAt.

- Pure `beginProviderRead` and `applyProviderRead` return replacement records, not mutate prior facts. Deeply copy incoming data/errors before storing them so later caller mutation, including Date.setTime(), cannot pollute internal facts.
- Membership and matching follow B exactly: only successful complete discovery replaces membership; use stable IDs only, never names/positions. No-ID items cannot inherit history across reads.
- A valid account result stores new data/time. Real zero consumption, 0% remaining, zero/negative monetary balances are valid finite data, not missing data.
- Unknown successful response records unknown and preserves the old valid fact internally only for explicitly historical metadata. Its current snapshot exposes no old number/balance. A subsequent failed query may show last valid data as clearly cached/stale, never fresh.
- Query failure records its own error/time and may inherit same-ID valid data. Discovery failure preserves previous account facts unchanged: no fake new per-account attempt/time/error.
- lastCompleteSuccessAt advances only on discovery success with every account valid, or successful empty discovery. Partial/unknown/error rounds do not advance it. Successful accounts in partial rounds advance only their own valid time.
- Source/config/session invalidation still removes the relevant records before new source results are accepted.

## 2. Detached derived snapshot

`deriveUsageSnapshot` is pure and receives the selected provider, enabled state, typed configuration status, provider record, B-derived refreshing flag, now and max age. It never reads disk, performs HTTP or schedules timers.

```ts
type UsageConfiguration =
  | { status: "pending" }
  | { status: "ready" }
  | { status: "setup-required";
      reason: "missing-key" | "missing-url" | "invalid-source" | "rejected";
      message?: string };
type AccountUsageSnapshot = {
  provider: ProviderName; accountId?: string; label: string;
  windows: UsageWindow[]; balance?: AccountBalance;
  result: "valid" | "unknown" | "error"; error?: string;
  queried: boolean; attemptedAt?: number; lastValidAt?: number;
  cached: boolean; stale: boolean;
};
type UsageSnapshot = {
  provider?: ProviderName;
  state: "unsupported" | "disabled" | "setup-required" | "idle" | "loading"
    | "ready" | "empty" | "unknown" | "error";
  configuration: UsageConfiguration;
  refreshing: boolean; stale: boolean; partial: boolean;
  accounts: AccountUsageSnapshot[];
  lastAttemptAt?: number; lastCompleteSuccessAt?: number;
  error?: string; generatedAt: number;
};
```

Snapshots use readonly types and detached read models: deeply clone the projected nested arrays, balances and Date values before returning. Mutation of a returned snapshot must not change internal state or a later snapshot. No credentials or key-derived identifiers in snapshots.

Derivation precedence: unsupported → disabled → setup-required → initial loading/idle → discovery error → successful empty → account result combinations. Refreshing is independent of retained outcomes; loading requires no previous outcome and actual pending/running work.

| Latest outcomes | State | partial |
| --- | --- | --- |
| all valid | ready | false |
| valid + error and/or unknown | ready | true |
| unknown + error, no valid | error | true |
| all unknown | unknown | false |
| all error, even with cached data | error | false |
| discovery failure | error, preserve account attempt facts | false |

Unknown-only is not empty; normal zero-account discovery is empty.

- Unsupported/disabled snapshots expose no account data and hide the widget; commands explain why.
- Setup reason comes from actual missing key/source fields or B's Management-auth result, never parsed from error text. The pre-resolution source state is pending, not a guessed missing URL.
- Discovery failure makes retained data cached/stale without changing account attempt facts. Failure to refresh an empty collection is error, not a new empty success.
- A displayed account is stale if age >= configured refresh interval, a query/discovery/config-auth failure applies, or any displayed known window reset is due. Quota/balance values themselves never change on expiry.
- Stale describes actual displayed data: an error/setup state with no usable value is not itself stale. cached identifies failure fallback; stale also covers age/reset expiry. Error + cached data renders data and the error annotation together. Unknown snapshots have no displayed historical data but may expose lastValidAt.

## 3. Controller and configuration integration

- Expose `getSnapshot(ctx, now?)` for the current-model scope and a private provider snapshot helper for already-open details. All use the same pure derivation and records.
- Keep the normalized resolved source alongside B's private key boundary; use the safe source fields to derive configuration. A pending source cannot be classified by guessing an error string.
- Move status preparation/formatting out of index.ts. Controller can load/sync configuration and resolve source without HTTP under a generation guard, then pass the same usage snapshot to shared formatting. Detecting a new source cancels old work and clears its records before reporting metadata.
- Preserve the lastRefresh helper as a derived compatibility getter returning a new Date from lastCompleteSuccessAt; no second authority.
- Request start/end and accepted results repaint the widget and notify subscribed details, so loading and background refreshing are actually visible. Keep B's context/generation guards on every async publication and callback.
- Close existing details before lifecycle/source invalidation and when selected provider changes. Same-provider model changes may keep the details. Dispose/unsubscribe normally; do not just suppress subscriptions after generation changes and leave a frozen old account view.
- No fabricated nextAllowedAt field in C. status may report the configured refresh interval, last attempt, complete success and account ages; actual backoff/limit gates belong to D.

DeepSeek: a structurally valid object response with missing/empty balance values is unknown, not a request failure or zero balance. Non-object roots, invalid balance_infos containers/entries or an invalid is_available type remain response errors. Add integration tests through readAccounts as well as pure state tests; do not weaken endpoint hostname restrictions.

## 4. Shared presentation

`src/ui.ts` adds shared short status and full snapshot formatting. Its widget renderer accepts the snapshot rather than a parallel data list. Keep current cards, bar widths, ordering and remaining-quota thresholds; add only short loading/unknown/stale/partial/error annotations. Unsupported/disabled stays hidden; successful empty and missing setup get explicit short text.

Details accepts one `getSnapshot()` plus existing actions/dispose callback. Pin status/error text above the scrolling account body; count pinned rows and footer/borders in available height. Account rows show last valid data age plus cached/error/unknown state. Existing r/scroll/Enter/Esc behavior stays Controller-backed.

Status and non-TUI notifications use the same full snapshot formatter. Filter/clamp control-bearing remote error text and redact known credentials before public state; never display raw provider response bodies. Preserve useful existing configuration rows and setup instructions, with no credential contents. Configuration reads are allowed; snapshot formatting itself performs no I/O.

Legacy pure formatDetails may remain for formatting raw parser fixtures, but live views must not derive their own independent cache/failure state.

## 5. One expiry repaint timer, no polling or network

Controller owns at most one extra setTimeout for the current widget's next future age/reset boundary. A pure deadline helper considers only future deadlines and returns none when already expired with no future change; avoid zero-delay loops. Bound long delays to the platform timeout maximum.

- Only a TUI/current provider with displayed valid data requires this timer. Reads/snapshots themselves never start it.
- Callback verifies saved generation/context ownership, recomputes the snapshot, repaints and reschedules, without HTTP.
- Recompute on results, current model and refresh interval changes; clear on invalidate/shutdown or unsupported/disabled models. Do not access an expired context.
- Details may retain its existing 30s redraw while open to keep ages/countdowns current. Its snapshot read stays pure and disposal clears its own interval.

## 6. Test-first matrix and delivery

Pure state tests: initial/refreshing/ready/empty/unknown/error/setup/disabled/unsupported and mixed-result table; unqueried auth-interrupted accounts do not advance account attempt times; input and output deep alias isolation; valid zeros and balances; mixed valid/unknown/failure; last-valid vs attempt vs complete-success times; discovery failure does not fake attempts; unknown hides old numbers; reliable identity/deletion; age/reset boundaries; snapshot nested-array/Date mutation isolation; future-only deadline selection.

Controller tests: loading paint, background refresh retains data, partial account times and complete-success time, error with/without cache, successful empty vs discovery failure, missing/rejected setup without string parsing, inferred source change, status/notification/widget/details agreement; fake Date/timers prove expiry redraw without HTTP and no timeout loops or stale-context callbacks. Keep all B ownership/cancellation tests.

UI tests: metadata annotations without changing card/color semantics; all three views describe the same snapshot; pinned details status remains visible when scrolling; total width/height bounded even on a very short terminal; unknown vs actual zero; safe timestamp age formatting.

Delivery: stacked PR with Closes #19, base B branch/depends #18. Run both SDKs' full tests/types/package checks and finite PTY replay. Save evidence before completion review; no merge or release. Separate pure state/reducer, Controller integration and view wiring changes into focused commits where they remain independently testable.
