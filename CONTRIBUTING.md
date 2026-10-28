# Contributing

Contributions are welcome. Keep changes focused, typed, and easy to review.

## Setup

Requirements: Node.js 22.19.0+ and Pi Coding Agent. CI uses Node.js 24.

```bash
git clone git@github.com:Zigerry/cliproxy-usage.git
cd cliproxy-usage
npm ci --ignore-scripts
```

Use the lockfile for reproducible installs. The only direct Pi development dependencies are the imported `pi-coding-agent` and `pi-tui`; `pi-agent-core` and `pi-ai` come through the SDK. The locked SDK ships an `npm-shrinkwrap.json`, so adding those unused direct dependencies installs an extra AI dependency tree.

Run extension locally:

```bash
pi --no-extensions -e ./index.ts
```

## Development

Follow module boundaries documented in [`AGENTS.md`](AGENTS.md). Keep `index.ts` limited to Pi lifecycle and command wiring. Put testable logic under `src/`.

Before submitting changes:

```bash
npm test
npm run check
npm pack --dry-run
```

Add or update tests for behavior changes and bug fixes. Tests belong in `test/`, use TypeScript and `node:test`, and must not depend on real credentials or provider requests.

CI checks the locked Pi SDK (`0.80.10`) and `1.3.0` in separate jobs. The latter changes only its job-local installation; keep the repository lockfile unchanged unless an SDK upgrade is intentional. Keep all four SDK packages aligned in that isolated override, even though only two are direct development dependencies. Local Node.js 22 runs skip the release shell drill, which requires native Node.js 24; use Node.js 24 for full CI-equivalent test coverage. For isolated PTY checks with synthetic accounts and network guards, see [the compatibility report](docs/compatibility-report.md). Python with `pexpect` is optional developer tooling for that manual check, not an extension dependency.

## Git workflow

1. Open an issue describing the problem, expected outcome, and relevant context before starting a pull request. Small typo or documentation-only fixes may skip this step.
2. Create a focused branch from `main` and reference the issue where practical:

   ```bash
   git switch -c feat/123-short-description
   ```

3. Make one logical change per commit.
4. Use [Conventional Commits](https://www.conventionalcommits.org/):

   ```text
   feat: add provider toggle
   fix: classify codex session window
   refactor: split usage client modules
   test: cover malformed auth files
   docs: document configuration path
   chore: update dependencies
   ```

5. Push branch and open a pull request linked to the issue. Do not commit directly to `main`.

## Pull requests

PR description should include:

- Linked issue (`Closes #123` when merge should resolve it).
- What changed.
- Why change is needed.
- How it was verified.
- Screenshots for visible TUI changes.

Keep PRs small. Avoid unrelated formatting or refactors.

## Security

- Never commit credentials, tokens, account files, or captured provider responses containing private data.
- Never log access or refresh tokens.
- Credentials may only be sent to official provider endpoints.
- Report security issues privately instead of opening a public issue.
