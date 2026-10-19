# Safe native refresh interval (#26)

Release-audit fix, stacked on source-observation PR #30. No version/tag/merge/publication.

Persisted refreshMinutes accepts only safe integer minutes 1..35791; larger values cannot be passed as a native signed-32-bit millisecond interval. Invalid values warn and use the existing five-minute default. The Controller also normalizes its adopted settings and scheduling entry, keeping freshness, actual timer delay, next-check metadata and local retry policy on the same effective interval. No new scheduler and no change to normal UI interval choices or visibility-only behavior.

Red-first isolated regressions reproduced invalid-range acceptance and unsafe scheduling. Final locked SDK 0.80.10 and isolated 1.3.0 each pass 301 full tests, types and pack checks. Cases include 35791/35792, very large/nonfinite/fractional/zero values, no early HTTP loop, actual periodic callback entry, fresh/stale deadlines and display-toggle anchor preservation. The source/cancellation/retry/display regressions remain passing. SDK rows are local, not a claim about remote CI. Integrated release verification is still pending remaining audited fixes.
