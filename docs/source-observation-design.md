# Release audit: source observation ownership (#25)

Stacked on E PR #24. Independent release-audit fixes implemented and locally verified; no tag/version/npm publish or main merge is authorized.

## Confirmed gaps

- A paused showStatus read can restore an obsolete inferred source after a refresh adopts another source. Lifecycle generation alone misses automatic adoption; clearing that newer boundary erases a live Retry-After gate.
- applySettings adopts a changed full source/key snapshot but some changed-ID branches return before clearing old source data.
- A same-value Management URL submission reaches the generic clear-all/force branch and can discard a live server gate despite no genuine source boundary change.

## Minimal design

Keep lifecycle generation and E's display revision. Add a small configuration/source observation revision: advance on authoritative non-display settings changes and on actual normalized Management source/key adoption. Visibility-only changes keep using displayRevision and must not cancel requests or restart scheduling.

Async status captures observation revision before its config/source reads and checks it as well as generation before mutating Controller state. If a newer adoption won, discard the obsolete observation and explain that status should be retried, without changing source, cache, timers or network policy. Do not issue provider HTTP from status. Cover source A -> B with a B 429 wait and a paused status still holding A; after release, forcing B must remain blocked.

A refresh also must not adopt a config/source observation superseded while it was reading. Pair any cached loaded settings with its own observation revision across queue merging; stale observations settle without overwriting newer authoritative config. Once a valid request reaches provider HTTP, quota results can still commit under existing generation/source ownership; visibility changes remain independent.

Process actual source/key changes before every applySettings early return: clear source-bound cache, rejection and cooldown facts, reset source boundary, and preserve original cancellation behavior. Same source/key values must not clear caches/server waits merely because a setting ID is submitted again. A cosmetic changed ID cannot disguise a real source change, and a no-op URL edit cannot bypass server limits.

Tests first: stale status/source race, reverse initial-adoption race where useful, config/source/key early-return matrix, no-op URL edit while waiting, old loaded/queue observations, and E visibility/late cancellation regressions. Preserve D concurrency, no HTTP from reads, timer semantics and credential handling. Full two-SDK tests/types/pack before PR; no auto merge or publishing.

## Verification

Red-first source-observation suite reproduced 19 failures (6 existing cases passed), then all 25 focused cases passed. Final locked 0.80.10 and isolated 1.3.0 each passed 292 full tests, types and package checks. Cases include both initial adoption orders, newer in-flight request ownership, source/key/provider changed-ID matrices, stale queued loaded snapshots, no-op URL submissions under server wait, and a real SettingsList first-save failure/second cumulative-save success. E visibility races and existing cancellation/retry regressions remain passing. These are local SDK rows, not a remote matrix or authorization to publish; the later integrated release candidate still needs verification.
