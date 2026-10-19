// Dependency-free release gates. Native Node 24 TypeScript; imports have no side effects.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";

const NAME = "cliproxy-usage";
const REPOSITORY = "Zigerry/cliproxy-usage";
const REGISTRY = "https://registry.npmjs.org";
export interface Identity { name: typeof NAME; version: string; tag: string; commit: string }
export interface SourceInput {
  tag: string; ref: string; refName: string; inputTag: string; event: string; repository: string;
  sha: string; commit: string; head: string; clean: boolean; onMain: boolean;
  manifest: unknown; lock: unknown;
}
function requireThat(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
function object(value: unknown): Record<string, unknown> {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
  return value as Record<string, unknown>;
}
function stable(version: string): bigint[] {
  requireThat(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), "Expected canonical stable X.Y.Z");
  return version.split(".").map(BigInt);
}
function compare(a: string, b: string): number {
  const aa = stable(a), bb = stable(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
function validateManifests(manifest: unknown, lock: unknown, version: string): void {
  const pkg = object(manifest), root = object(lock), entry = object(object(root.packages)[""]);
  for (const data of [pkg, root, entry]) {
    requireThat(data.name === NAME && data.version === version, "Package/lock name or version mismatch");
  }
}
export function validateSource(input: SourceInput): Identity {
  requireThat(input.tag.startsWith("v"), "Expected version tag");
  const version = input.tag.slice(1); stable(version);
  requireThat(input.repository === REPOSITORY, "Unexpected repository");
  requireThat(input.ref === `refs/tags/${input.tag}` && input.refName === input.tag, "Run must be at the named tag ref");
  requireThat(input.event === "push" || (input.event === "workflow_dispatch" && input.inputTag === input.tag), "Invalid event or dispatch tag");
  requireThat(/^[0-9a-f]{40}$/.test(input.commit) && input.sha === input.commit && input.head === input.commit, "Tag/run/checkout SHA mismatch");
  requireThat(input.clean && input.onMain, "Release needs a clean reviewed origin/main commit");
  validateManifests(input.manifest, input.lock, version);
  return { name: NAME, version, tag: input.tag, commit: input.commit };
}
const sha512 = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

// npm produces regular ustar files. Reject extensions/links/duplicates rather than
// interpreting a second, potentially different tar view from the extraction tool.
export function inspectArtifact(bytes: Buffer, identity: Identity, files: Record<string, Buffer>): string {
  const tar = gunzipSync(bytes, { maxOutputLength: 16 * 1024 * 1024 });
  const seen = new Set<string>(); let offset = 0;
  const text = (header: Buffer, start: number, end: number) => header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
  while (offset + 512 <= tar.length && !tar.subarray(offset, offset + 512).every(b => b === 0)) {
    const h = tar.subarray(offset, offset + 512);
    const field = text(h, 124, 136).trim();
    requireThat(/^[0-7]+$/.test(field), "Invalid tar size");
    const size = parseInt(field, 8), name = text(h, 0, 100);
    const check = Buffer.from(h); check.fill(32, 148, 156);
    requireThat(parseInt(text(h, 148, 156).trim(), 8) === [...check].reduce((a, b) => a + b, 0), "Invalid tar checksum");
    requireThat((h[156] === 0 || h[156] === 48) && !text(h, 157, 257) && !text(h, 345, 500), "Non-regular/extended tar entry");
    requireThat(name.startsWith("package/"), "Invalid tar prefix");
    const path = name.slice(8);
    requireThat(Object.hasOwn(files, path) && !seen.has(path), `Unexpected/duplicate package path: ${path}`);
    requireThat(size <= tar.length - offset - 512, "Truncated tar");
    const content = tar.subarray(offset + 512, offset + 512 + size);
    requireThat(content.equals(files[path]), `Package file differs from tag: ${path}`);
    if (path === "package.json") {
      const pkg = object(JSON.parse(content.toString("utf8")));
      requireThat(pkg.name === identity.name && pkg.version === identity.version, "Tar manifest mismatch");
    }
    seen.add(path); offset += 512 + Math.ceil(size / 512) * 512;
  }
  requireThat(tar.length - offset >= 1024 && tar.subarray(offset).every(b => b === 0), "Missing tar terminator or trailing content");
  requireThat(seen.has("package.json") && seen.size === Object.keys(files).length, "Missing package files");
  return sha512(bytes);
}
export function releaseRecord(identity: Identity, integrity: string): string {
  return JSON.stringify({ schema: 1, repository: REPOSITORY, ...identity,
    artifact: `${NAME}-${identity.version}.tgz`, integrity }, null, 2) + "\n";
}

type Fetcher = typeof fetch;
async function registryGet(url: string, fetcher: Fetcher): Promise<Response> {
  requireThat(url.startsWith(`${REGISTRY}/`) && new URL(url).origin === REGISTRY, "Non-official registry URL");
  return fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(30_000) });
}
async function metadata(url: string, fetcher: Fetcher, missingVersion?: string): Promise<Record<string, unknown> | null> {
  const response = await registryGet(url, fetcher);
  requireThat(response.status === 200 || response.status === 404, `Registry HTTP ${response.status}`);
  requireThat(response.headers.get("content-type")?.includes("application/json"), "Registry returned non-JSON metadata");
  const value: unknown = await response.json();
  if (response.status === 404) {
    const error = typeof value === "string" ? value : object(value).error;
    requireThat(missingVersion !== undefined && (
      error === `version not found: ${missingVersion}` || (typeof value !== "string" && error === "Not found")
    ), "Unrecognized registry404");
    return null;
  }
  const body = object(value);
  requireThat(body.name === NAME && typeof body.version === "string", "Invalid registry identity");
  stable(body.version);
  return body;
}
export async function registryVersion(identity: Identity, fetcher: Fetcher = fetch): Promise<Record<string, unknown> | null> {
  const body = await metadata(`${REGISTRY}/${NAME}/${identity.version}`, fetcher, identity.version);
  if (body) {
    requireThat(body.version === identity.version, "Registry version mismatch");
    const dist = object(body.dist);
    requireThat(typeof dist.integrity === "string" && typeof dist.tarball === "string", "Invalid registry dist metadata");
  }
  return body;
}
export async function registryLatest(fetcher: Fetcher = fetch): Promise<string> {
  const body = await metadata(`${REGISTRY}/${NAME}/latest`, fetcher);
  return body!.version as string;
}
export function publicationPlan(existing: boolean, version: string, latest: string): { publish: boolean } {
  const order = compare(version, latest);
  requireThat(existing || order > 0, "New publication must be newer than npm latest");
  return { publish: !existing };
}
interface VerifyOptions { fetcher?: Fetcher; attempts?: number; sleep?: (ms: number) => Promise<void> }
const sleep = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
export async function verifyRegistry(identity: Identity, bytes: Buffer, options: VerifyOptions = {}): Promise<void> {
  const { fetcher = fetch, attempts = 1, sleep: wait = sleep } = options;
  requireThat(Number.isInteger(attempts) && attempts >= 1 && attempts <= 6, "Invalid retry bound");
  for (let i = 0; i < attempts; i++) {
    const body = await registryVersion(identity, fetcher);
    if (!body) {
      requireThat(i + 1 < attempts, "Version missing after bounded verification");
      await wait(5000); continue;
    }
    const dist = object(body.dist);
    requireThat(dist.integrity === sha512(bytes), "Registry SHA512 mismatch");
    requireThat(body.gitHead === undefined || body.gitHead === identity.commit, "Registry gitHead mismatch");
    const url = `${REGISTRY}/${NAME}/-/${NAME}-${identity.version}.tgz`;
    requireThat(dist.tarball === url, "Unexpected registry tarball URL");
    const response = await registryGet(url, fetcher);
    requireThat(response.status === 200, `Registry tarball HTTP ${response.status}`);
    requireThat(Buffer.from(await response.arrayBuffer()).equals(bytes), "Registry tarball bytes differ");
    return;
  }
}

// gh --paginate --slurp returns one array per successfully fetched page. A
// complete authenticated list includes drafts; published-by-tag lookup may not.
export function githubReleaseId(raw: string, identity: Identity): number | undefined {
  const pages: unknown = JSON.parse(raw);
  requireThat(Array.isArray(pages) && pages.length > 0, "Invalid release pages");
  let found: number | undefined;
  for (const page of pages) {
    requireThat(Array.isArray(page), "Invalid release page");
    for (const value of page) {
      const release = object(value);
      requireThat(typeof release.tag_name === "string" && release.tag_name.length > 0 &&
        Number.isSafeInteger(release.id) && Number(release.id) > 0, "Invalid release list entry");
      if (release.tag_name === identity.tag) {
        requireThat(found === undefined, "Ambiguous release tag");
        found = Number(release.id);
      }
    }
  }
  return found;
}
interface GithubState { exists: boolean; draft: boolean; assets: { id: number; name: string }[] }
export function githubState(raw: string, success: boolean, identity: Identity, allowPublic: boolean, requireAssets: boolean, expectedId?: number): GithubState {
  const match = /^HTTP\/\S+ (\d{3})[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]+)$/.exec(raw);
  requireThat(match, "Missing GitHub API HTTP response");
  const status = Number(match[1]), body = object(JSON.parse(match[2]));
  // This is a read of an already discovered ID, never an absence probe.
  requireThat(success && status === 200, `GitHub API HTTP ${status}`);
  requireThat(expectedId === undefined || body.id === expectedId, "GitHub release ID mismatch");
  requireThat(body.tag_name === identity.tag && body.target_commitish === identity.commit && body.prerelease === false, "GitHub release tag/commit/type mismatch");
  requireThat(typeof body.draft === "boolean" && (body.draft || allowPublic), "Public release without verified npm version");
  requireThat(Number.isSafeInteger(body.id) && Number(body.id) > 0 && Array.isArray(body.assets), "Invalid release metadata");
  const names = [`${NAME}-${identity.version}.tgz`, "release-record.json"];
  const assets: GithubState["assets"] = [];
  for (const value of body.assets) {
    const asset = object(value);
    requireThat(typeof asset.name === "string" && names.includes(asset.name) && !assets.some(a => a.name === asset.name), "Unexpected/duplicate release asset");
    requireThat(Number.isSafeInteger(asset.id) && Number(asset.id) > 0 && asset.state === "uploaded", "Invalid release asset ID/state");
    assets.push({ id: Number(asset.id), name: asset.name });
  }
  requireThat(!(requireAssets || !body.draft) || assets.length === 2, "Incomplete release assets");
  return { exists: true, draft: body.draft, assets };
}

function githubApi(args: string[], operation: string): string {
  const result = spawnSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  requireThat(result.status === 0, `GitHub release ${operation} failed`);
  return result.stdout;
}
// Read-only shared probe, also usable for non-mutating live-contract verification.
export function readGithubState(identity: Identity, allowPublic: boolean, requireAssets: boolean): GithubState {
  const id = githubReleaseId(githubApi(["--paginate", "--slurp", `repos/${REPOSITORY}/releases?per_page=100`], "list"), identity);
  if (id === undefined) {
    requireThat(!requireAssets, "Expected existing release assets");
    return { exists: false, draft: false, assets: [] };
  }
  const raw = githubApi(["--include", `repos/${REPOSITORY}/releases/${id}`], "lookup");
  return githubState(raw, true, identity, allowPublic, requireAssets, id);
}

const env = (key: string) => process.env[key] ?? "";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const jsonFile = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
function toolchain(): void {
  requireThat(process.versions.node.split(".")[0] === "24", "Release requires Node 24");
  requireThat(execFileSync("npm", ["--version"], { encoding: "utf8" }).trim() === "12.2.0", "Release requires actual npm CLI 12.2.0");
}
function sourceIdentity(): Identity {
  const tag = env("RELEASE_TAG");
  requireThat(/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag), "Invalid release tag");
  const commit = git("rev-parse", `refs/tags/${tag}^{commit}`);
  return validateSource({ tag, ref: env("GITHUB_REF"), refName: env("GITHUB_REF_NAME"), inputTag: env("INPUT_TAG"),
    event: env("GITHUB_EVENT_NAME"), repository: env("GITHUB_REPOSITORY"), sha: env("GITHUB_SHA"), commit,
    head: git("rev-parse", "HEAD"), clean: git("status", "--porcelain", "--untracked-files=all") === "",
    onMain: spawnSync("git", ["merge-base", "--is-ancestor", commit, "refs/remotes/origin/main"]).status === 0,
    manifest: jsonFile("package.json"), lock: jsonFile("package-lock.json") });
}
function packageFiles(): Record<string, Buffer> {
  // Explicit tracked-source allowlist, no docs/tests/scripts/config/user files.
  const paths = git("ls-files", "-z").split("\0").filter(p =>
    ["package.json", "index.ts", "README.md", "LICENSE"].includes(p) || /^src\/[a-z][a-z0-9-]*\.ts$/.test(p));
  requireThat(["package.json", "index.ts", "README.md", "LICENSE"].every(p => paths.includes(p)), "Missing required package files");
  return Object.fromEntries(paths.map(p => [p, readFileSync(p)]));
}
function output(key: string, value: string | boolean): void {
  requireThat(!String(value).includes("\n") && env("GITHUB_OUTPUT"), "Invalid workflow output");
  writeFileSync(env("GITHUB_OUTPUT"), `${key}=${value}\n`, { flag: "a" });
}
function artifactDirectory(): string {
  const dir = resolve(env("RELEASE_DIR")); mkdirSync(dir, { recursive: true });
  const root = realpathSync("."), target = realpathSync(dir);
  requireThat(target !== root && !target.startsWith(root + sep), "Artifacts must be outside source tree");
  return target;
}
function bundle(identity: Identity): { bytes: Buffer; artifact: string; record: string } {
  const dir = artifactDirectory(), artifact = resolve(dir, `${NAME}-${identity.version}.tgz`), record = resolve(dir, "release-record.json");
  const bytes = readFileSync(artifact), integrity = inspectArtifact(bytes, identity, packageFiles());
  requireThat(readFileSync(record, "utf8") === releaseRecord(identity, integrity), "Release record differs from tag/artifact");
  return { bytes, artifact, record };
}
function pack(identity: Identity): void {
  const dir = artifactDirectory();
  const result = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { encoding: "utf8" });
  const packed: unknown = JSON.parse(result);
  const filename = `${NAME}-${identity.version}.tgz`;
  const summary = object(packed);
  requireThat(Object.keys(summary).length === 1 && object(summary[NAME]).filename === filename, "Unexpected npm 12 pack output");
  const artifact = resolve(dir, filename), record = resolve(dir, "release-record.json");
  const integrity = inspectArtifact(readFileSync(artifact), identity, packageFiles());
  writeFileSync(record, releaseRecord(identity, integrity));
  output("artifact", artifact); output("record", record); output("commit", identity.commit);
}
function bumpIdentity(): Identity {
  requireThat(env("GITHUB_REF") === "refs/heads/main" && env("GITHUB_REPOSITORY") === REPOSITORY, "Bump is main-only");
  const commit = git("rev-parse", "HEAD");
  requireThat(commit === env("GITHUB_SHA") && commit === git("rev-parse", "refs/remotes/origin/main"), "Bump source is not up-to-date main");
  requireThat(git("status", "--porcelain", "--untracked-files=all") === "", "Dirty bump source");
  const pkg = object(jsonFile("package.json")); requireThat(typeof pkg.version === "string", "Missing version"); stable(pkg.version);
  validateManifests(pkg, jsonFile("package-lock.json"), pkg.version);
  return { name: NAME, version: pkg.version, tag: `v${pkg.version}`, commit };
}
async function main(): Promise<void> {
  toolchain();
  const command = process.argv[2];
  if (command === "bump-preflight" || command === "bump-pack") {
    const identity = bumpIdentity(); if (command === "bump-pack") pack(identity); return;
  }
  if (command === "bump-tag") {
    const pkg = object(jsonFile("package.json")), tag = `v${pkg.version}`;
    requireThat(env("GITHUB_REF") === "refs/heads/main" && env("GITHUB_REPOSITORY") === REPOSITORY, "Bump is main-only");
    requireThat(typeof pkg.version === "string", "Missing bumped version"); stable(pkg.version);
    validateManifests(pkg, jsonFile("package-lock.json"), pkg.version);
    requireThat(git("status", "--porcelain", "--untracked-files=all") === "", "Dirty bumped tree");
    requireThat(git("rev-parse", `refs/tags/${tag}^{commit}`) === git("rev-parse", "HEAD"), "Bumped tag mismatch");
    requireThat(git("rev-parse", "HEAD^") === env("GITHUB_SHA") && git("rev-parse", "refs/remotes/origin/main") === env("GITHUB_SHA"), "Main advanced during bump");
    return;
  }
  const identity = sourceIdentity();
  if (command === "gate") return;
  if (command === "pack") { pack(identity); return; }
  const local = bundle(identity);
  if (command === "publish-gate") {
    requireThat(await registryVersion(identity) === null, "npm version appeared after planning; rerun for full verification");
    publicationPlan(false, identity.version, await registryLatest());
    return;
  }
  if (command === "plan") {
    const existing = await registryVersion(identity);
    if (existing) await verifyRegistry(identity, local.bytes);
    const plan = publicationPlan(existing !== null, identity.version, await registryLatest());
    output("publish", plan.publish); return;
  }
  if (command === "verify") {
    await verifyRegistry(identity, local.bytes, { attempts: 6 });
    let latest = await registryLatest();
    // A new publication must also have its npm latest pointer replicated. Never
    // repair/promote a historical rerun with npm dist-tag commands.
    if (env("EXPECT_PUBLISH") === "true") {
      for (let i = 1; latest !== identity.version && compare(latest, identity.version) < 0 && i < 6; i++) {
        await sleep(5000); latest = await registryLatest();
      }
      requireThat(latest === identity.version, "Published npm latest pointer not verified");
    }
    output("latest", latest === identity.version); return;
  }
  if (command === "gh-probe") {
    const state = readGithubState(identity, env("ALLOW_PUBLIC") === "true", env("REQUIRE_ASSETS") === "true");
    writeFileSync(env("STATE_FILE"), JSON.stringify(state)); return;
  }
  throw new Error("Unknown release command");
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message : "Release gate failed"); process.exitCode = 1; });
}
