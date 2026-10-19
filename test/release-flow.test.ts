import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { inspectArtifact, releaseRecord, type Identity } from "../scripts/release.js";

// This drill executes checked-in shell, not a reimplementation of release orchestration.
// No installs, credentials, commits, tags, dispatches or real publication. Node <24
// skips: CI uses native Node 24, including each helper subprocess (no tsx loader).
const root = fileURLToPath(new URL("../", import.meta.url));
const identity: Identity = { name: "cliproxy-usage", version: "1.2.3", tag: "v1.2.3", commit: "a".repeat(40) };
const artifactName = "cliproxy-usage-1.2.3.tgz";
const registry = "https://registry.npmjs.org/cliproxy-usage";
interface Step { name: string; id?: string; condition?: string; env: Record<string, string>; run: string }
function stepsFrom(text: string): Step[] {
  // Deliberately bounded YAML subset; unsupported syntax fails rather than silently
  // substituting a different command. No YAML dependency or copied shell bodies.
  return [...text.matchAll(/^      - name: (.+)\n([\s\S]*?)(?=^      - |$(?![\s\S]))/gm)].map(([, name, body]) => {
    const run = /^        run: (.+)\n?/m.exec(body);
    assert.ok(run, `Missing run: ${name}`);
    const env: Record<string, string> = {};
    const block = /^        env:\n((?:^          .+\n)+)/m.exec(body)?.[1] ?? "";
    for (const line of block.trimEnd().split("\n").filter(Boolean)) {
      const pair = /^          ([A-Z_]+): (.+)$/.exec(line);
      assert.ok(pair, `Unsupported env: ${line}`);
      env[pair[1]] = pair[2].replace(/^"(.*)"$/, "$1");
    }
    let shell = run[1];
    if (shell === "|") {
      shell = body.slice(run.index + run[0].length).split("\n").map(line => {
        assert.ok(!line || line.startsWith("          "), `Unsupported block: ${line}`);
        return line.slice(10);
      }).join("\n");
    }
    return { name, id: /^        id: (\w+)$/m.exec(body)?.[1], condition: /^        if: (.+)$/m.exec(body)?.[1], env, run: shell };
  });
}
type Outputs = Record<string, Record<string, string>>;
function expression(expr: string, outputs: Outputs): string {
  if (expr === "github.token" || expr === "secrets.NPM_TOKEN") return "fixture-only-not-a-credential";
  const match = /^steps\.(\w+)\.outputs\.(\w+)(?: == '(true|false)')?$/.exec(expr);
  assert.ok(match, `Unsupported workflow expression: ${expr}`);
  const value = outputs[match[1]]?.[match[2]];
  assert.notEqual(value, undefined, `Unset output: ${expr}`);
  return match[3] ? String(value === match[3]) : value;
}
function outputFile(file: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").trim().split("\n").filter(Boolean)) {
    const pair = /^(\w+)=([^\r\n]*)$/.exec(line);
    assert.ok(pair, `Invalid GITHUB_OUTPUT: ${line}`);
    assert.ok(!Object.hasOwn(result, pair[1]), `Duplicate output: ${line}`);
    result[pair[1]] = pair[2];
  }
  return result;
}
function executable(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const file = resolve(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* try next */ }
  }
  throw new Error(`Missing local executable: ${name}`);
}

// Preloaded before every fixture Node process, including real local npm pack.
// Even an unexpected URL/tool command fails closed; no host configs are inherited.
const guard = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
const deny = () => { throw new Error('Fixture forbids all real network'); };
net.Socket.prototype.connect = deny; net.Server.prototype.listen = deny;
net.connect = deny; net.createConnection = deny; tls.connect = deny;
http.request = deny; http.get = deny; https.request = deny; https.get = deny;
dgram.Socket.prototype.send = deny; dgram.Socket.prototype.connect = deny; dgram.Socket.prototype.bind = deny;
syncBuiltinESMExports();
export function log(kind, args = []) {
  const file = process.env.FIXTURE_LOG;
  const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
  const prev = lines.length ? JSON.parse(lines.at(-1)).hash : '';
  const entry = { n: lines.length + 1, prev, kind, args };
  const hash = createHash('sha256').update(JSON.stringify(entry)).digest('hex');
  appendFileSync(file, JSON.stringify({ ...entry, hash }) + '\n');
}
globalThis.fetch = async (url, init) => {
  assert.equal(process.env.FIXTURE_MODE, 'flow', 'No fetch during local pack');
  const prefix = 'https://registry.npmjs.org/cliproxy-usage';
  assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
  assert.equal(init?.headers, undefined);
  const path = String(url);
  assert.ok([prefix + '/1.2.3', prefix + '/latest', prefix + '/-/cliproxy-usage-1.2.3.tgz'].includes(path), 'Nonfixture fetch: ' + path);
  log('fetch', [path]);
  const state = JSON.parse(readFileSync(process.env.FIXTURE_STATE, 'utf8'));
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  if (path === prefix + '/latest') return json({ name: 'cliproxy-usage', version: state.latest });
  if (path === prefix + '/1.2.3') return state.metadata ? json(state.metadata) : json('version not found: 1.2.3', 404);
  assert.ok(state.metadata, 'Unpublished tarball');
  return new Response(Buffer.from(state.registryBytes, 'base64'));
};
`;

// Independent fake services implement CLI contracts, not workflow logic. Their
// append-only, hash-chained event journal is separate from mutable service state.
const tools = String.raw`
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { log } from './guard.mjs';
const args = process.argv.slice(2), tool = basename(process.argv[1]);
const file = process.env.FIXTURE_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const save = () => writeFileSync(file, JSON.stringify(state));
const equal = expected => assert.deepEqual(args, expected, tool + ' unexpected argv');
const repo = 'Zigerry/cliproxy-usage', tag = 'v1.2.3', sha = 'a'.repeat(40);
const artifact = process.env.FIXTURE_ARTIFACT;
const names = ['cliproxy-usage-1.2.3.tgz', 'release-record.json'];
if (tool === 'git') {
  log('git', args);
  if (JSON.stringify(args) === JSON.stringify(['rev-parse', 'refs/tags/' + tag + '^{commit}']) || JSON.stringify(args) === JSON.stringify(['rev-parse', 'HEAD'])) console.log(sha);
  else if (args[0] === 'status') { equal(['status', '--porcelain', '--untracked-files=all']); process.stdout.write(state.dirty ? ' M index.ts\n' : ''); }
  else if (args[0] === 'merge-base') { equal(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main']); process.exitCode = state.offMain ? 1 : 0; }
  else { equal(['ls-files', '-z']); process.stdout.write(['package.json', 'index.ts', 'README.md', 'LICENSE'].join('\0') + '\0'); }
} else if (tool === 'npm') {
  if (args[0] === '--version') { equal(['--version']); log('npm.version'); console.log(state.npmVersion); }
  else {
    log('npm.publish', args);
    equal(['publish', artifact, '--ignore-scripts', '--access', 'public', '--provenance', '--registry=https://registry.npmjs.org', '--tag=latest']);
    assert.equal(process.env.NODE_AUTH_TOKEN, 'fixture-only-not-a-credential');
    assert.equal(readFileSync(artifact).toString('base64'), state.expectedBytes);
    assert.equal(state.metadata, null, 'Cannot republish immutable version');
    if (state.publishFailure) process.exitCode = 51;
    else { state.metadata = state.expectedMetadata; state.registryBytes = state.expectedBytes; state.latest = '1.2.3'; save(); }
  }
} else if (tool === 'jq') {
  if (args[0] === '-r' && args.length === 3) {
    assert.ok(['.exists', '.draft'].includes(args[1]));
    console.log(JSON.parse(readFileSync(args[2], 'utf8'))[args[1].slice(1)]);
  } else {
    assert.deepEqual(args.slice(0, 3), ['-r', '--arg', 'name']);
    assert.ok(names.includes(args[3]));
    assert.equal(args[4], '.assets[] | select(.name == $name) | .id'); assert.equal(args.length, 6);
    const assets = JSON.parse(readFileSync(args[5], 'utf8')).assets.filter(a => a.name === args[3]);
    process.stdout.write(assets.map(a => String(a.id) + '\n').join(''));
  }
} else if (tool === 'gh') {
  assert.equal(process.env.GH_TOKEN, 'fixture-only-not-a-credential');
  if (args[0] === 'api' && args[1] === '--include') {
    equal(['api', '--include', 'repos/' + repo + '/releases/tags/' + tag]); log('gh.probe', args);
    const status = state.release ? 200 : 404;
    console.log('HTTP/2.0 ' + status + ' Test\r\nContent-Type: application/json\r\n\r\n' + JSON.stringify(state.release ? { ...state.release, assets: state.release.assets.map(({ bytes, ...asset }) => asset) } : { message: 'Not Found' }));
    if (status === 404) process.exitCode = 1;
  } else if (args[0] === 'api') {
    assert.equal(args.length, 4); assert.equal(args[2], '-H'); assert.equal(args[3], 'Accept: application/octet-stream');
    const asset = state.release?.assets.find(a => args[1] === 'repos/' + repo + '/releases/assets/' + a.id);
    assert.ok(asset, 'Unexpected asset endpoint'); log('gh.download', [asset.name]);
    process.stdout.write(Buffer.from(asset.bytes, 'base64'));
  } else if (args[0] === 'release' && args[1] === 'create') {
    log('gh.create', args);
    equal(['release', 'create', tag, '--repo', repo, '--target', sha, '--verify-tag', '--draft', '--latest=false', '--title', tag, '--generate-notes', '--notes', 'Exact tarball and commit record attached; npm/asset identity is verified before public release.']);
    assert.equal(state.release, null);
    if (state.createFailure) process.exitCode = 52;
    else { state.release = { id: 1, tag_name: tag, target_commitish: sha, draft: true, prerelease: false, assets: [] }; save(); }
  } else if (args[0] === 'release' && args[1] === 'upload') {
    log('gh.upload', args); assert.equal(args.length, 6);
    assert.deepEqual(args.slice(0, 3), ['release', 'upload', tag]); assert.deepEqual(args.slice(4), ['--repo', repo]);
    const name = basename(args[3]); assert.ok(names.includes(name));
    assert.equal(args[3], name === names[0] ? artifact : process.env.FIXTURE_RECORD);
    assert.ok(state.release?.draft); assert.ok(!state.release.assets.some(a => a.name === name), 'No overwrites');
    state.release.assets.push({ id: name === names[0] ? 2 : 3, name, state: 'uploaded', bytes: readFileSync(args[3]).toString('base64') }); save();
  } else {
    log('gh.edit', args);
    assert.equal(args.length, 7); assert.deepEqual(args.slice(0, 6), ['release', 'edit', tag, '--repo', repo, '--draft=false']);
    assert.ok(['--latest=true', '--latest=false'].includes(args[6]));
    assert.ok(state.metadata); assert.ok(state.release); assert.equal(state.release.assets.length, 2);
    state.release.draft = false; if (args[6] === '--latest=true') state.githubLatest = tag; save();
  }
} else throw new Error('Unexpected executable: ' + tool);
`;

interface Asset { id: number; name: string; state: string; bytes: string }
interface Release { id: number; tag_name: string; target_commitish: string; draft: boolean; prerelease: boolean; assets: Asset[] }
interface Metadata { name: string; version: string; gitHead: string; dist: { integrity: string; tarball: string } }
interface State {
  npmVersion: string; metadata: Metadata | null; registryBytes: string; latest: string; githubLatest: string;
  expectedMetadata: Metadata; expectedBytes: string; release: Release | null;
  createFailure?: boolean; publishFailure?: boolean; dirty?: boolean; offMain?: boolean;
}
interface Event { n: number; prev: string; kind: string; args: string[]; hash: string }
function journal(file: string): Event[] {
  const events = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event);
  let prev = "";
  events.forEach(({ hash, ...entry }, index) => {
    assert.equal(entry.n, index + 1); assert.equal(entry.prev, prev);
    assert.equal(hash, createHash("sha256").update(JSON.stringify(entry)).digest("hex")); prev = hash;
  });
  return events;
}

test("actual release shell is fail-closed and recoverable against isolated GH/npm services", {
  skip: process.versions.node.split(".")[0] !== "24" ? "Requires native Node 24; no test toolchain downloads" : false,
}, async t => {
  const dir = mkdtempSync(join(tmpdir(), "release-flow-"));
  try {
    const bin = join(dir, "bin"), home = join(dir, "home"), seed = join(dir, "seed"), packed = join(dir, "packed");
    for (const path of [bin, home, seed, packed]) mkdirSync(path);
    writeFileSync(join(bin, "guard.mjs"), guard);
    const nativeNode = process.execPath;
    for (const name of ["gh", "git", "npm", "jq"]) writeFileSync(join(bin, name), `#!${nativeNode}\n${tools}`, { mode: 0o755 });
    const userconfig = join(home, "npmrc"), globalconfig = join(home, "global-npmrc");
    writeFileSync(userconfig, ""); writeFileSync(globalconfig, "");
    // Construct from scratch: never spread process.env (tokens, NODE_OPTIONS,
    // proxies, GH config and user npm lifecycle settings must not leak in).
    const cleanEnv: NodeJS.ProcessEnv = {
      PATH: `${dirname(nativeNode)}:/usr/bin:/bin`, HOME: home, TMPDIR: dir,
      NODE_OPTIONS: `--import=${pathToFileURL(join(bin, "guard.mjs")).href}`,
      NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig,
      NPM_CONFIG_CACHE: join(home, "cache"), NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
      FIXTURE_LOG: join(dir, "pack-events.jsonl"),
    };
    writeFileSync(cleanEnv.FIXTURE_LOG!, "");
    const realNpm = executable("npm"), bash = executable("bash");
    const localPackNpmVersion = execFileSync(realNpm, ["--version"], { env: cleanEnv, encoding: "utf8" }).trim();
    assert.match(localPackNpmVersion, /^\d+\.\d+\.\d+$/, "Use the available local npm for fixture-only packing");
    // Production installs and checks npm 12.2.0. This isolated service stub
    // models that contract without requiring ordinary CI to install that CLI.
    const npmVersion = "12.2.0";
    const manifest = { name: identity.name, version: identity.version, type: "module", files: ["index.ts", "README.md", "LICENSE"] };
    const files: Record<string, Buffer> = {
      "package.json": Buffer.from(JSON.stringify(manifest) + "\n"),
      "index.ts": Buffer.from("export {};\n"), "README.md": Buffer.from("Fixture only\n"), "LICENSE": Buffer.from("MIT\n"),
    };
    for (const [name, content] of Object.entries(files)) writeFileSync(join(seed, name), content);
    // The only real npm operation besides --version is a local, script-free pack.
    execFileSync(realNpm, ["pack", "--ignore-scripts", "--json", "--pack-destination", packed], { cwd: seed, env: cleanEnv, stdio: "pipe" });
    assert.deepEqual(readdirSync(packed), [artifactName]);
    const bytes = readFileSync(join(packed, artifactName));
    const integrity = inspectArtifact(bytes, identity, files);
    const record = releaseRecord(identity, integrity);
    const expectedMetadata: Metadata = { name: identity.name, version: identity.version, gitHead: identity.commit,
      dist: { integrity, tarball: `${registry}/-/${artifactName}` } };
    const workflow = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8");
    const parsed = stepsFrom(workflow.split(/^  publish:\n/m)[1]);
    const find = (name: string) => { const step = parsed.find(s => s.name === name); assert.ok(step, `Missing workflow step: ${name}`); return step; };
    const gate = find("Validate exact tagged provenance and original manifests");
    const plan = find("Verify npm state and reject downgrades");
    const stage = find("Stage recoverable draft and verify same-artifact assets");
    const publish = find("Publish exact verified tgz");
    const verify = find("Verify registry bytes and latest after publication or rerun");
    const finalize = find("Finalize verified release");
    const pack = find("Pack once and inspect real tar bytes");
    assert.equal(pack.id, "pack"); assert.equal(plan.id, "plan"); assert.equal(verify.id, "verify");
    assert.equal(publish.condition, "steps.plan.outputs.publish == 'true'");
    assert.deepEqual(stage.env, {
      GH_TOKEN: "${{ github.token }}", ARTIFACT: "${{ steps.pack.outputs.artifact }}", RECORD: "${{ steps.pack.outputs.record }}",
      COMMIT: "${{ steps.pack.outputs.commit }}", ALLOW_PUBLIC: "${{ steps.plan.outputs.publish == 'false' }}",
    });
    assert.deepEqual(publish.env, { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}", ARTIFACT: "${{ steps.pack.outputs.artifact }}" });
    assert.deepEqual(verify.env, { EXPECT_PUBLISH: "${{ steps.plan.outputs.publish }}" });
    assert.deepEqual(finalize.env, { GH_TOKEN: "${{ github.token }}", ARTIFACT: "${{ steps.pack.outputs.artifact }}",
      RECORD: "${{ steps.pack.outputs.record }}", REQUIRE_ASSETS: "true", ALLOW_PUBLIC: "true", MAKE_LATEST: "${{ steps.verify.outputs.latest }}" });
    assert.match(publish.run, /node scripts\/release\.ts publish-gate\n\s*npm publish "\$ARTIFACT"/);
    const sequence = [gate, plan, stage, publish, verify, finalize];
    assert.ok(sequence.every((step, i) => i === 0 || parsed.indexOf(sequence[i - 1]) < parsed.indexOf(step)));
    for (const step of [gate, plan, stage, verify, finalize]) assert.equal(step.condition, undefined, `Unexpected skipped safety step: ${step.name}`);
    const fullAssets = (): Asset[] => [
      { id: 2, name: artifactName, state: "uploaded", bytes: bytes.toString("base64") },
      { id: 3, name: "release-record.json", state: "uploaded", bytes: Buffer.from(record).toString("base64") },
    ];
    const release = (draft = true, assets = fullAssets()): Release => ({ id: 1, tag_name: identity.tag, target_commitish: identity.commit, draft, prerelease: false, assets });
    let fixtureNumber = 0;
    function fixture(change: Partial<State> = {}) {
      const work = join(dir, String(++fixtureNumber)), source = join(work, "source"), artifacts = join(work, "artifacts");
      mkdirSync(source, { recursive: true }); mkdirSync(artifacts); mkdirSync(join(source, "scripts"));
      for (const [name, content] of Object.entries(files)) writeFileSync(join(source, name), content);
      writeFileSync(join(source, "package-lock.json"), JSON.stringify({ name: identity.name, version: identity.version, lockfileVersion: 3, packages: { "": manifest } }));
      // Copy the actual CLI verbatim; never transpile or replace its implementation.
      copyFileSync(join(root, "scripts/release.ts"), join(source, "scripts/release.ts"));
      const artifact = join(artifacts, artifactName), recordPath = join(artifacts, "release-record.json");
      writeFileSync(artifact, bytes); writeFileSync(recordPath, record);
      const stateFile = join(work, "services.json"), logFile = join(work, "events.jsonl");
      writeFileSync(logFile, "");
      const initial: State = { npmVersion, metadata: null, registryBytes: "", latest: "1.2.2", githubLatest: "v1.2.2",
        expectedMetadata, expectedBytes: bytes.toString("base64"), release: null, ...change };
      writeFileSync(stateFile, JSON.stringify(initial));
      const env: NodeJS.ProcessEnv = { ...cleanEnv, PATH: `${bin}:${cleanEnv.PATH}`, FIXTURE_MODE: "flow", FIXTURE_STATE: stateFile,
        FIXTURE_LOG: logFile, FIXTURE_ARTIFACT: artifact, FIXTURE_RECORD: recordPath,
        RELEASE_DIR: artifacts, RUNNER_TEMP: work, GH_RESPONSE: join(work, "gh-response"), STATE_FILE: join(work, "gh-state"),
        RELEASE_TAG: identity.tag, INPUT_TAG: identity.tag, GITHUB_REF: `refs/tags/${identity.tag}`, GITHUB_REF_NAME: identity.tag,
        GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REPOSITORY: "Zigerry/cliproxy-usage", REPOSITORY: "Zigerry/cliproxy-usage", GITHUB_SHA: identity.commit,
      };
      const outputs: Outputs = { pack: { artifact, record: recordPath, commit: identity.commit } };
      const state = () => JSON.parse(readFileSync(stateFile, "utf8")) as State;
      const update = (change: Partial<State>) => writeFileSync(stateFile, JSON.stringify({ ...state(), ...change }));
      function run(options: { beforePublish?: () => void; beforeStep?: (step: Step) => void; mutate?: (step: Step) => string } = {}) {
        const attempted: string[] = [];
        for (const step of sequence) {
          if (step.condition && expression(step.condition, outputs) !== "true") continue;
          if (step === publish) options.beforePublish?.();
          options.beforeStep?.(step);
          attempted.push(step.name);
          const output = join(work, `output-${attempted.length}`); writeFileSync(output, "");
          const stepEnv: NodeJS.ProcessEnv = { ...env, GITHUB_OUTPUT: output };
          for (const [key, value] of Object.entries(step.env)) stepEnv[key] = value.replace(/\$\{\{ (.+?) \}\}/g, (_, expr: string) => expression(expr, outputs));
          const result = spawnSync(bash, ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", options.mutate?.(step) ?? step.run], {
            cwd: source, env: stepEnv, encoding: "utf8", timeout: 20_000,
          });
          assert.ifError(result.error); assert.equal(result.signal, null);
          if (result.status !== 0) return { failed: step.name, stderr: result.stderr, stdout: result.stdout, attempted };
          if (step.id) outputs[step.id] = outputFile(output);
        }
        return { failed: undefined, stderr: "", stdout: "", attempted };
      }
      return { run, state, update, outputs, env, source, artifact, events: () => journal(logFile) };
    }
    type Fixture = ReturnType<typeof fixture>;
    const count = (f: Fixture, kind: string) => f.events().filter(e => e.kind === kind).length;
    function noPublication(f: Fixture) {
      assert.equal(count(f, "npm.publish"), 0); assert.equal(count(f, "gh.edit"), 0);
    }
    function noAssetWrites(f: Fixture) { assert.equal(count(f, "gh.upload"), 0); }
    const existing: Partial<State> = { metadata: expectedMetadata, registryBytes: bytes.toString("base64"), latest: "1.2.3" };

    await t.test("network guard and fake CLI controls fail before any real side effect", () => {
      const f = fixture();
      for (const code of [
        "await fetch('https://example.invalid/escape')",
        "await fetch('https://registry.npmjs.org/not-the-fixture', { method: 'GET', redirect: 'error' })",
        "(await import('node:net')).connect(443, 'registry.npmjs.org')",
        "(await import('node:https')).get('https://registry.npmjs.org')",
      ]) {
        const result = spawnSync(nativeNode, ["--input-type=module", "-e", code], { env: f.env, encoding: "utf8" });
        assert.notEqual(result.status, 0); assert.match(result.stderr, /Nonfixture fetch|forbids all real network|strictEqual/);
      }
      assert.equal(f.env.NODE_AUTH_TOKEN, undefined); assert.equal(f.env.GH_TOKEN, undefined);
      const badPublish = spawnSync(join(bin, "npm"), ["publish", "/not-the-artifact"], { env: f.env, encoding: "utf8" });
      assert.notEqual(badPublish.status, 0); assert.match(badPublish.stderr, /unexpected argv/);
      assert.equal(count(f, "npm.publish"), 1); assert.equal(f.state().metadata, null);
      const logFile = f.env.FIXTURE_LOG!;
      writeFileSync(logFile, readFileSync(logFile, "utf8").replace('"n":1', '"n":2'));
      assert.throws(() => f.events(), assert.AssertionError, "Journal counter tampering must be detected");
    });
    await t.test("draft creation failure stops the chain before publication", () => {
      const f = fixture({ createFailure: true }), result = f.run();
      assert.equal(result.failed, stage.name); assert.equal(count(f, "gh.create"), 1);
      noPublication(f); noAssetWrites(f); assert.equal(f.state().release, null);
      assert.ok(!result.attempted.includes(verify.name));
    });
    await t.test("wrong existing record is checked before uploading the missing artifact", () => {
      const wrong = { ...fullAssets()[1], bytes: Buffer.from("wrong record\n").toString("base64") };
      const f = fixture({ release: release(true, [wrong]) }), result = f.run();
      assert.equal(result.failed, stage.name); assert.match(result.stdout, /differ/);
      assert.equal(count(f, "gh.download"), 1); noAssetWrites(f); noPublication(f);
      assert.deepEqual(f.state().release?.assets, [wrong]);
    });
    await t.test("npm failure leaves a recoverable unpublished draft and its exact assets", () => {
      const f = fixture({ publishFailure: true }), result = f.run();
      assert.equal(result.failed, publish.name); assert.equal(count(f, "npm.publish"), 1); assert.equal(count(f, "gh.edit"), 0);
      assert.equal(count(f, "gh.upload"), 2); assert.equal(f.state().release?.draft, true);
      assert.deepEqual(f.state().release?.assets, fullAssets()); assert.equal(f.state().metadata, null);
      assert.equal(f.state().latest, "1.2.2"); assert.ok(!result.attempted.includes(verify.name));
    });
    for (const mismatch of ["SHA512", "bytes", "gitHead"] as const) await t.test(`existing npm ${mismatch} mismatch stops before any GH writes`, () => {
      const metadata = structuredClone(expectedMetadata);
      if (mismatch === "SHA512") metadata.dist.integrity = "sha512-wrong";
      if (mismatch === "gitHead") metadata.gitHead = "b".repeat(40);
      const f = fixture({ ...existing, metadata, registryBytes: mismatch === "bytes" ? Buffer.from("wrong bytes").toString("base64") : bytes.toString("base64") });
      const result = f.run();
      assert.equal(result.failed, plan.name); assert.match(result.stderr, /Registry (SHA512 mismatch|tarball bytes differ|gitHead mismatch)/);
      noPublication(f); noAssetWrites(f); assert.equal(count(f, "gh.probe"), 0); assert.equal(f.state().release, null);
    });
    await t.test("matching existing npm and GH assets skip npm and never overwrite assets", () => {
      const initialRelease = release();
      const f = fixture({ ...existing, release: initialRelease }), result = f.run();
      assert.equal(result.failed, undefined, result.stderr); assert.equal(f.outputs.plan.publish, "false");
      assert.equal(f.outputs.verify.latest, "true"); assert.equal(count(f, "npm.publish"), 0); noAssetWrites(f);
      assert.equal(count(f, "gh.create"), 0); assert.equal(count(f, "gh.edit"), 1);
      assert.equal(f.state().release?.draft, false); assert.deepEqual(f.state().release?.assets, initialRelease.assets);
      assert.ok(!result.attempted.includes(publish.name));
    });
    for (const draft of [false, true]) await t.test(`historical ${draft ? "draft" : "public"} retry preserves both npm and GH latest at 2.0.0`, () => {
      const f = fixture({ ...existing, latest: "2.0.0", githubLatest: "v2.0.0", release: release(draft) });
      const result = f.run();
      assert.equal(result.failed, undefined, result.stderr); assert.equal(f.outputs.plan.publish, "false"); assert.equal(f.outputs.verify.latest, "false");
      assert.equal(count(f, "npm.publish"), 0); assert.equal(count(f, "gh.edit"), draft ? 1 : 0);
      noAssetWrites(f); assert.equal(count(f, "gh.create"), 0);
      assert.equal(f.state().latest, "2.0.0"); assert.equal(f.state().githubLatest, "v2.0.0");
      assert.deepEqual(f.state().release, release(false));
    });
    await t.test("new publication passes immediate gate and verifies before finalizing", () => {
      const f = fixture(), result = f.run();
      assert.equal(result.failed, undefined, result.stderr); assert.equal(f.outputs.plan.publish, "true"); assert.equal(f.outputs.verify.latest, "true");
      assert.equal(count(f, "npm.publish"), 1); assert.equal(count(f, "gh.upload"), 2); assert.equal(count(f, "gh.edit"), 1);
      assert.equal(f.state().latest, "1.2.3"); assert.equal(f.state().githubLatest, identity.tag);
      assert.equal(f.state().release?.draft, false);
      const events = f.events(), published = events.findIndex(e => e.kind === "npm.publish"), edited = events.findIndex(e => e.kind === "gh.edit");
      assert.deepEqual(events.slice(published - 2, published).map(e => e.args[0]), [`${registry}/1.2.3`, `${registry}/latest`]);
      assert.ok(events.slice(published + 1, edited).some(e => e.kind === "fetch" && e.args[0] === `${registry}/-/${artifactName}`));
      assert.ok(events.slice(published + 1, edited).some(e => e.kind === "fetch" && e.args[0] === `${registry}/latest`));
      const gitCalls = events.filter(e => e.kind === "git");
      // gate + plan + three staging probes + publish-gate + verify + final probe.
      assert.equal(gitCalls.filter(e => e.args[0] === "rev-parse" && e.args[1] === "HEAD").length, 8);
      assert.equal(gitCalls.filter(e => e.args[0] === "ls-files").length, 7);
    });
    await t.test("registry byte mismatch after successful npm publication cannot finalize the draft", () => {
      const f = fixture();
      const result = f.run({ beforeStep: step => {
        if (step === verify) f.update({ registryBytes: Buffer.from("bad replicated bytes").toString("base64") });
      } });
      assert.equal(result.failed, verify.name); assert.match(result.stderr, /Registry tarball bytes differ/);
      assert.equal(count(f, "npm.publish"), 1); assert.equal(count(f, "gh.edit"), 0);
      assert.equal(f.state().release?.draft, true); assert.ok(!result.attempted.includes(finalize.name));
    });
    await t.test("finalization re-download detects GH asset mutation after successful registry verification", () => {
      const f = fixture({ ...existing, release: release() });
      const result = f.run({ beforeStep: step => {
        if (step === finalize) {
          const changed = f.state().release!;
          changed.assets[1].bytes = Buffer.from("tampered GH record").toString("base64");
          f.update({ release: changed });
        }
      } });
      assert.equal(result.failed, finalize.name); assert.match(result.stdout, /differ/);
      assert.equal(f.outputs.verify.latest, "true"); noPublication(f); noAssetWrites(f);
      assert.equal(f.state().release?.draft, true);
    });
    for (const race of ["version", "latest", "dirty", "off-main", "artifact"] as const) await t.test(`immediate publish-gate rejects ${race} change after staging`, () => {
      const f = fixture();
      const result = f.run({ beforePublish: () => {
        if (race === "version") f.update(existing);
        if (race === "latest") f.update({ latest: "2.0.0" });
        if (race === "dirty") f.update({ dirty: true });
        if (race === "off-main") f.update({ offMain: true });
        if (race === "artifact") writeFileSync(f.artifact, "tampered");
      } });
      assert.equal(result.failed, publish.name); noPublication(f);
      assert.equal(f.state().release?.draft, true); assert.equal(count(f, "gh.upload"), 2);
      assert.ok(!result.attempted.includes(verify.name));
      assert.match(result.stderr, /version appeared|newer than npm latest|clean reviewed|header|gzip|compression/i);
    });
    await t.test("negative controls: shell-only fail-open mutations trip the effect assertions", () => {
      // Never write mutations to the helper or workflow. Prove that merely seeing
      // a failed step is insufficient: forbidden side effects are detected too.
      const wrong = { ...fullAssets()[1], bytes: Buffer.from("wrong record\n").toString("base64") };
      const f = fixture({ release: release(true, [wrong]) });
      const result = f.run({ mutate: step => step === stage ? step.run.replace('cmp "$file" "$RUNNER_TEMP/download-$name"', ": # injected missing validation") : step.run });
      assert.equal(result.failed, stage.name); assert.equal(count(f, "gh.upload"), 1);
      assert.throws(() => noAssetWrites(f), assert.AssertionError);
      const g = fixture();
      const bypass = g.run({ beforePublish: () => g.update(existing), mutate: step => step === publish ? step.run.replace("node scripts/release.ts publish-gate", ": # injected missing gate") : step.run });
      assert.equal(bypass.failed, publish.name); assert.equal(count(g, "npm.publish"), 1);
      assert.match(bypass.stderr, /Cannot republish immutable version/);
      assert.throws(() => noPublication(g), assert.AssertionError);
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
