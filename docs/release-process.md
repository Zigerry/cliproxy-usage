# Release process

Preparation only: this workflow patch is not release approval. No version is
selected here. Source/configuration CI work (#15) remains separate. Integration,
a version bump, tag push, dispatch and publication each require authorization.

## One production path

`Publish` alone handles a tag push or a manual dispatch. For recovery, dispatch
Publish **at the existing tag ref**, with the identical `tag` input; dispatching
from main with a tag input is rejected. The tagged commit must contain this
workflow and helper. Only canonical stable `vX.Y.Z` is accepted. Package name
`cliproxy-usage` and all three manifest/lock root identities must agree. The
checkout must be clean, HEAD and the run's provenance SHA must equal the resolved
tag commit, and that commit must be on fetched `origin/main` in the expected
repository. Tags and published npm versions are immutable.

Publish and Bump share the `production-release` concurrency group, with
`cancel-in-progress: false`. Keep these workflows as the sole production writer;
GitHub concurrency is not a distributed lock against external npm/GitHub users.
GitHub also allows only one pending run per group; review pending runs rather
than treating this as a durable release queue.

1. Separate jobs test/typecheck the locked SDK **0.80.10** and isolated **1.3.0**.
   The compatibility install uses `--no-save --package-lock=false`; it never
   supplies files to the publishing job. Source/configuration PR CI is unchanged.
2. A fresh checkout of the exact tag uses Node **24**, with the actual npm CLI
   explicitly installed and checked as **12.2.0**. It installs the original lock.
3. `node scripts/release.ts pack` calls `npm pack --ignore-scripts` **once**, to
   runner temp outside the source tree. It inspects the real gzip/tar, not npm's
   file summary: only regular files, no duplicate/traversal paths, and exactly
   tracked `package.json`, `index.ts`, `README.md`, `LICENSE`, and `src/*.ts` from
   the explicit source naming allowlist. Every file must match the checkout byte
   for byte. Tests/docs/scripts/configuration/user files are not shipped. The
   deterministic `release-record.json` contains repository, tag, commit, version,
   artifact name and SHA512 of the compressed tarball.
4. Unauthenticated GETs to the official public npm registry determine whether
   the version exists and inspect `latest`. Only a JSON HTTP404 with the known
   npm not-found error is absence. Network errors, redirects, authorization
   errors, rate limiting, server errors and malformed metadata stop the run.
   Existing versions require matching name/version, SHA512 metadata, any supplied
   `gitHead`, and downloaded registry tarball bytes. New versions must be strictly
   newer than npm latest; historical retries never retag npm latest.
5. **Prefer a GitHub draft before npm.** Create a draft targeted at the validated
   commit with generated change notes, upload the exact tarball plus record, then download both and compare
   every byte before publication. An existing release must match tag, target
   commit, type and asset identity. Existing assets are downloaded and verified;
   mismatches stop, never overwrite. No asset-clobber option is used. A public
   existing release is accepted only for an already verified npm version, with
   both matching assets present. Stage and finalization share a read-only native
   probe: successful `gh api --paginate --slurp` fetches every authenticated
   releases-list page (including drafts), strictly matches the tag and rejects
   malformed/duplicate matches, then reads and validates the identified numeric
   release ID. Only a complete successful list with no match permits creation.
   List failures/partial output, ID lookup404 and ambiguous results never mean
   absence. Published-by-tag lookup is not used for draft discovery. Queries
   exceeding the 16MiB metadata buffer fail closed. The stage records gh's actual
   version; upload/edit retain its separately documented draft-aware lookup.
6. Only the npm publishing step receives repository secret `NPM_TOKEN` as
   `NODE_AUTH_TOKEN`. It publishes the **.tgz**, never a directory, with scripts
   disabled, public access and provenance (`id-token: write`). No other step
   receives that token. Immediately before publishing, the unauthenticated gate
   rechecks that the version is still missing and still newer than latest; any
   intervening publication stops for a fully verified rerun. A secret's presence
   does not establish its validity.
7. After publication (or a verified rerun), verify registry metadata and actual
   bytes again. Missing metadata is retried at most six times, five seconds
   apart; transient latest-pointer replication is bounded similarly. Other
   failures stop rather than being treated as absence. A new publication's npm
   latest must be verified. The draft's downloaded assets/record are checked
   again before making it public. Finalization preserves generated or maintainer-edited
   release notes rather than replacing them with a generic success line. `--latest=false` keeps a historical retry from
   becoming the GitHub latest release; it never moves npm dist-tags. A failed
   publish/verification cannot execute public finalization.

A tarball publish does **not** guarantee npm supplies `gitHead`. If present it
must match; absence is not fabricated. Same-commit linkage also comes from the
same-tag workflow run/provenance and the attached release record. Inspect npm
provenance in the first authorized real release; local mocks cannot attest it.

## Bump entry point (manual, main only)

Bump rejects non-main dispatches and stale/dirty reviewed main checkouts. It
checks the original manifests, runs locked tests/types and a real pack inspection
before `npm version`. It fetches and checks main again, creates the version
commit/tag with lifecycle scripts disabled, validates the resulting manifests,
clean tree, tag and parent, then atomically pushes only `HEAD:main` and that tag.
Checkout does not persist repository credentials for dependency installation/tests;
only the final push/dispatch step configures gh's environment-backed git helper.
No force push or protection bypass is attempted. An advanced main, protection or
credential failure must fail visibly. It then dispatches **only Publish**, using
`--ref "$tag" -f tag="$tag"`: GITHUB_TOKEN pushes do not themselves start tag
workflows. A dispatch failure after a successful push requires authorized manual
Publish recovery at that tag; do not run Bump again to repair dispatch.

## Failure and recovery

There is no npm/GitHub transaction. A draft with the exact tarball/record is the
recovery anchor, not a declaration of success. If npm fails, leave the draft
unpublished. If npm succeeds but verification or GitHub fails, stop and rerun
Publish at the same tag after investigation. Never unpublish/reuse a version as
rollback, move a tag, replace assets, or publish different bytes to "repair" it.
The rerun re-packs with the pinned toolchain and must reproduce the stored and
registry bytes. A transport/CDN tarball read error stops rather than expanding the
bounded missing-metadata retry policy; investigate and use the verified same-tag
rerun, never call such a failure success. If it cannot, preserve the draft/artifacts and investigate
manually. A legacy release whose target/record/assets do not satisfy the gates
needs explicit manual investigation, not an automatic overwrite.

GitHub documents that an upload502 can leave an empty `starter` asset. The gate
rejects it, and a same-name upload must not overwrite it. An operator must confirm
the failed upload, exact release/asset ID and starter state, then obtain explicit
approval to remove only that failed starter before same-tag recovery. Never delete
an uploaded/verified or merely mismatched asset to force a gate to pass.

Historical target commits with workflow-file differences from current main can
require Workflows-write permission for GitHub release mutations; the standard
GITHUB_TOKEN cannot obtain it. Review workflow-path differences **before** any
historical recovery publication and stop for an approved recovery plan when this
condition applies. An ancestor-of-main check alone does not establish mutation
permission. Current-main first publication does not exercise this historical case.
See GitHub's [create/update release](https://docs.github.com/rest/releases/releases)
and [asset upload](https://docs.github.com/rest/releases/assets#upload-a-release-asset)
contracts. The tool does not automatically switch credentials or deletion paths.

Local verification: `npm test` and `npm run check` include typed helper imports
through TSX `.js` resolution. Run the helper natively with Node 24 (erasable
TypeScript only). Tests use mock fetch and temporary local packs, not credentials,
real publication or GitHub mutations. Workflow wiring assertions are not an
end-to-end Actions, OIDC, branch-protection, GitHub API, or NPM_TOKEN test. No real
NPM_TOKEN validity, npm provenance, publication or release finalization is
verified by preparation. Review and explicit later approval remain required.
