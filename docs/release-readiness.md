# Release preparation and integration record

Status: local integration, fault-injection validation, remote workflow PR CI and advisor preparation-completion review passed. Preparation is complete; explicit version/merge/release authorization is still required. This is not approval to merge or publish. Proposed next version: **0.6.0**, awaiting maintainer confirmation. No version has been changed, no release workflow dispatched, and no tag/npm/GitHub release mutation performed by this preparation.

## Published baseline

npm latest, GitHub latest release and tag are all 0.5.1. npm gitHead and v0.5.1 resolve to `76fcacb0aeef72aae601a0430bfbd88df18f8962`. Do not overwrite this version or move its tag. Local npm is not authenticated; the repository has the existing NPM_TOKEN secret name, but its value/validity was not read or tested. Publication authentication/provenance requires a first authorized real run.

The old Publish run `33156422268` was inspected read-only: queued since the historical 0.5.1 release with no jobs. It was not cancelled or rerun. Do not use the old parallel Publish/Release/Bump path while preparing this release.

## Independent audit and fixes

| Finding | Fix | Verification before workflow integration |
| --- | --- | --- |
| Stale config/status observations could undo newer source boundaries/waits; cumulative settings IDs and same-value URL edits mishandled boundaries | #25 / PR #30 | 25 focused cases; both SDKs 292 full tests/types/pack |
| Persisted multi-day intervals could overflow native timers into a 1ms loop | #26 / PR #32 | boundary/overflow/freshness/real tick tests; both SDKs 301 full tests/types/pack |
| Engine-specific invalid configuration diagnostics were not stable across command paths | #27 / PR #33 | loader and real settings/setup/login/logout early-rejection paths; both SDKs 308 tests/types/pack |
| Malformed supplied supported fields disappeared from usable subsets without a completeness warning | #28 / PR #34 | retained subset/history/unknown/recovery and HTTP/data-success separation; both SDKs 336 tests/types/pack |
| Empty and literal fallback names could become indistinguishable in widget | #29 / PR #35 | effective labels and ordinals at narrow/normal widths; both SDKs 337 tests/types/pack |
| Parallel release workflows could report GitHub success independently of npm, or blindly skip an existing version | #31 / PR #36 | single draft/verified-artifact path; helper/wiring/fault-injection and integrated checks below |

The startup concurrency regression test now waits on a real request barrier rather than a single setImmediate: filesystem scheduling is not a synchronization guarantee. Cache/manual-refresh assertions remain intact. No live provider or personal configuration was used in tests.

## Final integration checks

The isolated candidate combines #15, A–E, all audited runtime fixes and the new release orchestration without touching remote main:

- Code commit: `ec377925156d8de12e88479febdda1e30cbc18bd`.
- Compatibility commit: `aedc9d8cbd1c36923cfafb8f1bd4ada4dcfc7b8b`.
- Actual integrated code tree: `487b900c0193faba0e931d578717101029eadf60` (recorded before this self-referential verification document was added).
- Node 24.22.0 / actual npm 12.2.0: both locked SDK 0.80.10 and isolated SDK 1.3.0 pass **368/368** full tests, types, zero failures/cancellations/skips. Current-SDK installation used the exact workflow no-save/no-lock mutation approach; both original manifests remained byte-identical.
- actionlint 1.7.12 passes the combined workflow tree. Its official archive SHA256 was verified (`8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`). It caught an unsupported job-level runner context in the draft; paths now initialize in a runner step, with a regression assertion.
- The new fault drill executes checked-in workflow shell and the native helper against isolated fake gh/npm/registry services, not a copied workflow implementation. All 19 fault/control scenarios pass, including actual gate failure, draft/asset mismatch, npm failure, existing-version mismatch, recovery, latest preservation, postpublish tampering and negative fail-open mutations. Socket/HTTP guards, synthetic tokens and isolated config prevent real publishing/network or reading user credentials. It was also tested with ordinary Node24/npm11 local fixture packing, so normal CI need not install the production npm CLI just to run tests.
- Three enhanced PTY modes pass: 0.80.10 regular, 1.3.0 regular, 1.3.0 fullscreen. Each checks host theme changes, real widget settings hide/show, hidden details/r, live 30/40-column quota fields, status/model switches and orderly exit; exactly three synthetic discovery/quota reads and zero unexpected guarded network attempts.
- A real non-dry-run npm pack produced exactly 18 allowlisted files. Native helper inspection checked gzip/tar structure and every file byte against the integrated source; release tooling/tests/docs/config were excluded. Repacking the final code tree reproduced the exact runtime artifact used for the successful PTY replay.

Inspected compressed artifact SRI:

```text
sha512-IKDYafcAilhUyBLbv6yw17iYR+rm5Nvh0r51isvyEuEYFUCv4XemHWtCwjGpqwduyE3c0FqhnnAYVKb+ELL/OA==
```

These are **local integrated** results, not the remote CI matrix or a real release. PR #36's inherited locked-SDK remote CI also passed: run `39223124474`, job `117962903497` (1m16s). Runtime fix PRs #30 and #32–#35 have passing inherited CI. Package/lock versions remain unchanged. Verification-only documentation added afterward does not change the inspected runtime files.

The inspection artifact still has the unchanged development manifest version 0.5.1. It is **not** the published 0.5.1 package and **must never be published** under that version. A separately approved 0.6.0 commit/tag must be rebuilt and verified by the pipeline; the eventual release hash will necessarily differ when its manifest/version changes.

## Proposed 0.6.0 notes (not published)

- More trustworthy explicit quota windows, zero/unknown values, partial payloads and balances.
- Stable per-account/source isolation, obsolete-work cancellation and shared cache freshness state.
- Server Retry-After, bounded local backoff and separate eligibility/actual automatic-check metadata.
- Complete narrow quota/balance fields, host theme colors and a display-only widget toggle.
- Safe configuration diagnostics and timer bounds; no new runtime dependency, persisted usage history or automatic account routing.

The authorized workflow generates GitHub notes from merged changes and preserves maintainer edits when finalizing. It attaches the same verified tarball and commit/integrity record used for npm.

## Planned merge and release order (not executed)

1. Merge independent compatibility PR #15 to main, then A #16.
2. Retarget and merge B #18, C #20, D #22 and E #24 in order.
3. Retarget and merge audited fixes #30 -> #32 -> #33 -> #34 -> #35, then workflow PR #36 (#31).
4. Prefer merge commits preserving stacked ancestry. If using squash/rebase, rebase/retarget each child and recheck its actual diff/CI; never merge a child only into its obsolete feature parent. Check main's final CI after integration, not just individual old PR checks.
5. Only after explicit version/release approval, inspect the effective main version. If it is still 0.5.1 and 0.6.0 is approved, the manual main-only Bump input is minor. The old Bump workflow must not be triggered before the unified workflow changes are in main.
6. The authorized Bump tests, bumps, atomically pushes main/tag and dispatches only Publish at that exact tag. See [release-process.md](release-process.md) for immutable tag/artifact checks, draft staging, npm verification, public finalization and failures.

There is no atomic transaction across npm and GitHub. Leave an unsuccessful release as a draft; if npm succeeded and GitHub did not, investigate and rerun the same tag/verified bytes. Never republish different bytes, unpublish/reuse a version, move a tag or clobber assets to repair a mismatch. A dispatch failure after a successful tag push is repaired with an authorized same-tag Publish dispatch, not another version bump.

## Limits

Tests, static workflow validation and isolated fault simulations cannot prove real NPM_TOKEN validity, OIDC provenance, GitHub API authorization, branch protection or registry/CDN replication in a production run. Finite PTY checks do not cover every terminal/provider schema or all host resource disposal. Preparation can establish the verified code/artifact/pipeline contract, not guarantee simultaneous cross-platform publication or immunity from independent external publishers.
