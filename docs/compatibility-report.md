# Pi compatibility verification — plan G

Status: verification passed within the scope below. No runtime implementation or SDK dependency upgrade is included in this batch.

## Scope and conclusion

The existing extension at baseline commit `3f4cf3e` passed unit tests, type checks, package checks and the bounded PTY smoke below with Pi SDK `0.80.10` and `1.3.0`. These are two verified versions, not proof of compatibility with every intervening, older or newer release.

- Host: Linux, Node.js `22.23.2`, npm `12.2.0`, terminal `xterm-256color`, 120 columns × 40 rows.
- SDK engine requirement at both tested endpoints: Node.js `>=22.19.0`. Contributor instructions now reflect that; CI uses Node.js 24.
- Repository `package.json`, `package-lock.json`, peer ranges and runtime sources are unchanged.
- Separate disposable project copies were used. The baseline copy used `npm ci --ignore-scripts`; the current copy changed only the four direct Pi development packages to exact `1.3.0`. Their transitive dependencies naturally differ.
- The first tested SDK remains the development lockfile baseline. No evidence from G requires a runtime API adaptation or an SDK upgrade before batch A.

## Results

| Environment | Unit tests | `tsc --noEmit` | `npm pack --dry-run` | Real PTY smoke |
| --- | --- | --- | --- | --- |
| Pi `0.80.10` | 55 passed, 0 failed | passed | 14 files, LICENSE included | regular: passed |
| Pi `1.3.0` | 55 passed, 0 failed | passed | 14 files, LICENSE included | regular and fullscreen: passed |
| Working checkout, locked SDK | 55 passed, 0 failed | passed | 14 files; fixtures/docs excluded | not used for terminal launch |

The CI workflow now has independent locked/current (`1.3.0`) SDK jobs for tests, types and package checks. It has not been run remotely during this task. PTY smoke remains optional manual developer tooling and is not silently claimed as CI coverage.

## PTY assertions

Each of the three runs checked actual terminal output, not only an exit code. Before each operation the driver consumes buffered output until a quiet boundary, so assertions cannot accept a previous operation's leftover redraw:

1. Startup widget renders synthetic Codex quota with `left 75%`.
2. `/cliproxy-usage` opens a titled overlay with keyboard help.
3. `r` goes through the real Controller/queue; the updated **details row** must contain `7d`, `left 65%`, and `resets in 2d` together with its enclosing borders. The underlying widget's redraw alone cannot satisfy this assertion.
4. Esc closes the overlay; the command can reopen it; Enter closes the second instance.
5. `/cliproxy-usage settings` opens the native settings list, and Esc returns.
6. `/cliproxy-usage status` reports Codex and a refresh timestamp.
7. Public `pi.setModel()` changes to `openai/o3`; the same command context reads the updated model, and the usage command reports unsupported. Switching back reads `gpt-4o`.
8. A fixture command calls public `ctx.shutdown()`; the shutdown event is recorded exactly once, and the process exits normally with status 0.
9. Exactly two discovery and two synthetic quota calls occurred. Both model switches were recorded in order. No unexpected network attempts were recorded by the guards.

The fixture calls the actual, unchanged `index.ts` factory. It does not replace host UI components, patch private runtime state or bypass the Controller to supply account data.

The orderly exit assertion does **not** prove that every unref timer or resource was cleaned up. Existing unit tests cover details disposal, while exhaustive lifecycle cancellation belongs to batch B.

## Isolation and network safety

The PTY child receives a small environment allowlist, a new HOME, XDG directories, agent directory and cwd, plus `--no-session`, `--offline`, disabled resource discovery and explicit extension loading. No provider credentials or personal configuration are inherited. Settings contain only synthetic values and an `.invalid` Management hostname.

A verification-only Node preload handles the expected Management fetches in memory. It rejects other fetch destinations, socket connections and HTTP(S) request/get calls before they can use the network. Provider endpoint strings in the synthetic api-call payload are inspected but never contacted. This is a guard for the tested Node code paths, not an operating-system network sandbox or a claim about arbitrary native subprocesses.

The fixture re-establishes the synthetic fetch before the extension's `session_start` handler because the current Pi startup HTTP dispatcher can replace a preload-installed global fetch. Socket/HTTP guards remain active throughout.

## Reproduction

Optional developer prerequisites: Python 3 with `pexpect`, a PTY-capable Linux environment, Node.js 22.19.0+, npm. `pexpect` is not an npm dependency or a dependency of the installed extension. It was already present in the verification environment.

Run from the repository root. Dependency installation needs network access; the subsequent smoke uses only synthetic responses and blocks the guarded runtime network paths.

```bash
REPO="$PWD"
CHECK_ROOT="$(mktemp -d /tmp/cliproxy-compat-XXXXXX)"
mkdir -p "$CHECK_ROOT/baseline" "$CHECK_ROOT/current" "$CHECK_ROOT/evidence"

for variant in baseline current; do
  cp package.json package-lock.json tsconfig.json index.ts README.md LICENSE "$CHECK_ROOT/$variant/"
  cp -R src test "$CHECK_ROOT/$variant/"
done

(cd "$CHECK_ROOT/baseline" && npm ci --ignore-scripts)
(cd "$CHECK_ROOT/current" && npm install --ignore-scripts --save-dev --save-exact \
  @earendil-works/pi-agent-core@1.3.0 @earendil-works/pi-ai@1.3.0 \
  @earendil-works/pi-coding-agent@1.3.0 @earendil-works/pi-tui@1.3.0)

for variant in baseline current; do
  (cd "$CHECK_ROOT/$variant" && npm test && npm run check && npm pack --dry-run)
done

python3 "$REPO/test/compatibility/smoke.py" baseline regular "$CHECK_ROOT"
python3 "$REPO/test/compatibility/smoke.py" current regular "$CHECK_ROOT"
python3 "$REPO/test/compatibility/smoke.py" current fullscreen "$CHECK_ROOT"
```

Use disposable copies only. The smoke creates synthetic settings, an extension fixture and log files inside the supplied workspace. It overwrites that workspace's per-run logs on rerun; archive failed runs before retrying. The script reads the actual SDK version into the result JSON. It deliberately refuses baseline fullscreen because it is outside the verified matrix.

The reproduction commands save raw PTY transcripts, sanitized text, event JSONL and result JSON under `$CHECK_ROOT/evidence/`; npm logs can also be captured there. The durable aggregate is [compatibility-results.json](compatibility-results.json); the replay fixtures are in `test/compatibility/` and are excluded from the npm package by the existing files allowlist.

## Harness failures investigated

Two initial smoke attempts failed and were archived, not misreported as product failures:

- `attempt-1-preload-replaced`: Pi startup replaced the preload fetch mock. The socket guard blocked a connection, and the widget showed `fetch failed`. The fixture now restores the mock from a test-only global symbol before the real extension's startup handler. No network guard was removed.
- `attempt-2-autocomplete`: Enter was consumed by slash-command argument completion rather than executing settings. The driver now dismisses that completion menu before Enter. It does not alter the extension or host input handler.

After completion review, all three runs were repeated with quiet-boundary draining and the stricter details-row assertion. The earlier successful runs are preserved in `attempt-3-before-phase-drain`; the top-level evidence contains the final reruns.

An inspection helper also assumed npm pack JSON was an array. npm 12 returned an object keyed by package name; the helper was corrected. The package commands themselves succeeded. The disposable snapshots were then completed with LICENSE and repacked; all three final file lists contain 14 entries.

## Limits and next actions

Not verified by this smoke: real provider accounts, setup/password masking, logout races, reload/session replacement races, arbitrary narrow widths, actual theme changes, other operating systems/terminals, RPC/JSON/print behavior, or timer completeness. Batches A–E retain their own regression requirements.

The runtime is ready for batch A on the verified SDK baselines; no new minimum-version promise or broad peer range change is warranted. Parser correctness is tracked separately in [issue #14](https://github.com/Zigerry/cliproxy-usage/issues/14). This report does not claim delivery of the subsequent cache, state, refresh or UI changes.
