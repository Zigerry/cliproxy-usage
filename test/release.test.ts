import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  validateSource, inspectArtifact, releaseRecord, publicationPlan,
  registryVersion, registryLatest, verifyRegistry, verifyLatest, REPLICATION_ATTEMPTS, githubState, githubReleaseId,
  type Identity, type SourceInput,
} from "../scripts/release.js";

const identity: Identity = { name: "cliproxy-usage", version: "1.2.3", tag: "v1.2.3", commit: "a".repeat(40) };
const manifest = { name: identity.name, version: identity.version };
const source: SourceInput = {
  tag: identity.tag, ref: "refs/tags/v1.2.3", refName: identity.tag,
  inputTag: identity.tag, event: "workflow_dispatch", repository: "Zigerry/cliproxy-usage",
  sha: identity.commit, commit: identity.commit, head: identity.commit, clean: true, onMain: true,
  manifest, lock: { ...manifest, packages: { "": manifest } },
};
const files = { "package.json": Buffer.from(JSON.stringify(manifest)), "index.ts": Buffer.from("export {};\n") };
function tar(entries: Record<string, Buffer>, type = "0"): Buffer {
  const chunks: Buffer[] = [];
  for (const [path, bytes] of Object.entries(entries)) {
    const header = Buffer.alloc(512);
    header.write(`package/${path}`); header.write("0000644\0", 100);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.fill(32, 148, 156); header.write(type, 156); header.write("ustar\0", 257);
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148);
    chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}
const bytes = tar(files);
const integrity = inspectArtifact(bytes, identity, files);
const metadata = { ...manifest, gitHead: identity.commit, dist: { integrity, tarball: `https://registry.npmjs.org/cliproxy-usage/-/cliproxy-usage-1.2.3.tgz` } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const mock = (body: unknown = metadata, archive: Buffer = bytes): typeof fetch => async (url) => String(url).endsWith(".tgz") ? new Response(new Uint8Array(archive)) : json(body);

test("source gate requires canonical tag, same-tag dispatch, manifest/lock identity, exact provenance and reviewed clean tree", () => {
  assert.deepEqual(validateSource(source), identity);
  assert.deepEqual(validateSource({ ...source, event: "push", inputTag: "" }), identity);
  for (const change of [
    { tag: "v01.2.3" }, { tag: "v1.2.3-beta.1" }, { tag: "v1.2.3+build" },
    { ref: "refs/heads/main" }, { refName: "v9.9.9" }, { inputTag: "v9.9.9" },
    { event: "pull_request" }, { repository: "other/cliproxy-usage" },
    { sha: "b".repeat(40) }, { head: "b".repeat(40) }, { clean: false }, { onMain: false },
    { manifest: { ...manifest, name: "wrong" } },
    { lock: { ...manifest, version: "1.2.4", packages: { "": manifest } } },
    { lock: { ...manifest, packages: { "": { ...manifest, version: "1.2.4" } } } },
    { lock: { ...manifest, packages: { "": { ...manifest, name: "wrong" } } } },
  ]) assert.throws(() => validateSource({ ...source, ...change }), Error, JSON.stringify(change));
});

test("real tar bytes, not pack summary: strict allowlist, file contents, manifest, duplicates and non-files", () => {
  assert.match(integrity, /^sha512-/);
  assert.throws(() => inspectArtifact(tar({ ...files, "test/private.ts": Buffer.from("secret") }), identity, files));
  assert.throws(() => inspectArtifact(tar({ ...files, "../secret": Buffer.from("secret") }), identity, files));
  assert.throws(() => inspectArtifact(tar({ "index.ts": files["index.ts"] }), identity, files));
  assert.throws(() => inspectArtifact(tar({ ...files, "index.ts": Buffer.from("changed") }), identity, files));
  assert.throws(() => inspectArtifact(tar(files, "2"), identity, files));
  assert.throws(() => inspectArtifact(bytes, { ...identity, version: "9.0.0" }, files));
  const raw = execFileSync("gzip", ["-dc"], { input: bytes });
  assert.throws(() => inspectArtifact(gzipSync(Buffer.concat([raw.subarray(0, -1024), raw])), identity, files));
  assert.equal(releaseRecord(identity, integrity), releaseRecord({ ...identity }, integrity));
  assert.match(releaseRecord(identity, integrity), /"commit": "aaaaaaaa/);
});

test("temporary real npm pack can be inspected without changing source or shipping release tooling", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-test-"));
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { cwd: dir, encoding: "utf8" });
    assert.match(inspectArtifact(readFileSync(join(dir, "cliproxy-usage-1.2.3.tgz")), identity, files), /^sha512-/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registry GET is unauthenticated official-only and only known JSON HTTP404 means missing", async () => {
  for (const body of [{ error: "Not found" }, { error: "version not found: 1.2.3" }]) {
    assert.equal(await registryVersion(identity, async (url, init) => {
      assert.equal(String(url), "https://registry.npmjs.org/cliproxy-usage/1.2.3");
      assert.equal(init?.redirect, "error"); assert.equal(init?.headers, undefined);
      assert.equal(init?.method, "GET"); return json(body, 404);
    }), null);
  }
  for (const status of [401, 403, 429, 500, 503]) await assert.rejects(registryVersion(identity, async () => json({ error: "Not found" }, status)));
  for (const response of [new Response("<html>Not found</html>", { status: 404 }), json({}, 404), json({ error: "forbidden" }, 404), json({}), new Response("bad json")]) {
    await assert.rejects(registryVersion(identity, async () => response));
  }
  await assert.rejects(registryVersion(identity, async () => { throw new Error("network"); }));
  await assert.rejects(registryLatest(async () => json({ error: "Not found" }, 404)));
  assert.equal(await registryLatest(mock()), "1.2.3");
});

test("official version-missing JSON string is absence only for exact version and HTTP404", async () => {
  const missing = `version not found: ${identity.version}`;
  assert.equal(await registryVersion(identity, async () => json(missing, 404)), null);
  for (const body of ["version not found: 9.9.9", "Not found", "unavailable", `${missing} `, null, [], { error: "version not found: 9.9.9" }]) {
    await assert.rejects(registryVersion(identity, async () => json(body, 404)));
  }
  for (const status of [200, 302, 401, 403, 429, 500, 503]) {
    await assert.rejects(registryVersion(identity, async () => json(missing, status)));
  }
  await assert.rejects(registryVersion(identity, async () => new Response(JSON.stringify(missing), {
    status: 404, headers: { "content-type": "text/plain" },
  })));
  await assert.rejects(registryVersion(identity, async () => new Response("not json", {
    status: 404, headers: { "content-type": "application/json" },
  })));
  await assert.rejects(registryLatest(async () => json(missing, 404)));
});

test("existing and newly published npm versions require identity, SHA512, optional gitHead and exact downloaded tgz", async () => {
  await verifyRegistry(identity, bytes, { fetcher: mock() });
  const { gitHead: _, ...withoutGitHead } = metadata;
  await verifyRegistry(identity, bytes, { fetcher: mock(withoutGitHead) });
  for (const bad of [
    { ...metadata, name: "other" }, { ...metadata, version: "1.2.4" }, { ...metadata, gitHead: "b".repeat(40) },
    { ...metadata, dist: { ...metadata.dist, integrity: "sha512-wrong" } },
    { ...metadata, dist: { ...metadata.dist, tarball: "https://evil.test/a.tgz" } },
  ]) await assert.rejects(verifyRegistry(identity, bytes, { fetcher: mock(bad) }));
  await assert.rejects(verifyRegistry(identity, bytes, { fetcher: mock(metadata, Buffer.from("different tar")) }));
});

test("postpublish replication retries are bounded, only missing is retried, no blind success", async () => {
  let calls = 0; let waits = 0;
  const fetcher: typeof fetch = async (url) => {
    if (!String(url).endsWith(".tgz") && ++calls < 3) return json("version not found: 1.2.3", 404);
    return mock()(url);
  };
  await verifyRegistry(identity, bytes, { fetcher, attempts: 3, sleep: async () => { waits++; } });
  assert.equal(calls, 3); assert.equal(waits, 2);
  calls = 0;
  await assert.rejects(verifyRegistry(identity, bytes, { attempts: 3, sleep: async () => {}, fetcher: async () => { calls++; return json({ error: "Not found" }, 404); } }));
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(verifyRegistry(identity, bytes, { attempts: 3, sleep: async () => {}, fetcher: async () => { calls++; return json({}, 503); } }));
  assert.equal(calls, 1);
});

function fakeReplication() {
  let elapsed = 0;
  const waits: number[] = [];
  return { attempts: REPLICATION_ATTEMPTS, now: () => elapsed,
    sleep: async (ms: number) => { waits.push(ms); elapsed += ms; },
    advance: (ms: number) => { elapsed += ms; }, waits };
}
const recovery = /npm may already have accepted publication.*same tag.*do not republish or bump/;

test("replication survives more than six delays and exhausts within three minutes without real sleep", async () => {
  const clock = fakeReplication(); let calls = 0;
  await verifyRegistry(identity, bytes, { ...clock, fetcher: async url => {
    if (!String(url).endsWith(".tgz") && ++calls <= 8) return json({ error: "Not found" }, 404);
    return mock()(url);
  } });
  assert.equal(calls, 9); assert.deepEqual(clock.waits, Array(8).fill(5000));
  for (const verify of [verifyRegistry.bind(null, identity, bytes), verifyLatest.bind(null, identity)]) {
    const clock = fakeReplication(); let calls = 0;
    await assert.rejects(verify({ ...clock, fetcher: async url => {
      calls++;
      return String(url).endsWith("/latest") ? json({ ...manifest, version: "1.2.2" }) : json("version not found: 1.2.3", 404);
    } }), recovery);
    assert.equal(calls, 37); assert.equal(clock.now(), 180_000);
    assert.deepEqual(clock.waits, Array(36).fill(5000));
  }
});

test("HTTP time consumes the replication window and sleep overruns cannot start another request", async () => {
  for (const verify of [verifyRegistry.bind(null, identity, bytes), verifyLatest.bind(null, identity)]) {
    const clock = fakeReplication(); let calls = 0;
    await assert.rejects(verify({ ...clock, fetcher: async url => {
      calls++; clock.advance(30_000);
      return String(url).endsWith("/latest") ? json({ ...manifest, version: "1.2.2" }) : json({ error: "Not found" }, 404);
    } }), recovery);
    assert.equal(calls, 6); assert.equal(clock.now(), 205_000);
    assert.equal(clock.waits.length, 5);
    calls = 0;
    await assert.rejects(verify({ ...fakeReplication(), now: clock.now,
      sleep: async () => { clock.advance(180_001); }, fetcher: async url => {
        calls++;
        return String(url).endsWith("/latest") ? json({ ...manifest, version: "1.2.2" }) : json({ error: "Not found" }, 404);
      } }), recovery);
    assert.equal(calls, 1);
  }
});

test("latest catches up after extended lag but ahead, rollback and unsafe metadata fail immediately", async () => {
  const clock = fakeReplication(); let calls = 0;
  assert.equal(await verifyLatest(identity, { ...clock, fetcher: async () => {
    calls++; return json({ ...manifest, version: calls <= 8 ? "1.2.2" : identity.version });
  } }), identity.version);
  assert.equal(calls, 9); assert.equal(clock.waits.length, 8);
  const rollback = fakeReplication(); calls = 0;
  await assert.rejects(verifyLatest(identity, { ...rollback, fetcher: async () => {
    calls++; return json({ ...manifest, version: calls === 1 ? "1.2.2" : "1.2.1" });
  } }), /rolled back/);
  assert.equal(calls, 2); assert.equal(rollback.waits.length, 1);
  for (const response of [
    () => json({ ...manifest, version: "2.0.0" }),
    () => json({ ...manifest, version: "1.2.3-rc.1" }),
    () => json({ ...manifest, name: "other" }), () => json({}),
    () => json({ error: "Not found" }, 404),
    () => new Response("not json", { headers: { "content-type": "application/json" } }),
    ...[401, 403, 429, 500, 503].map(status => () => json({}, status)),
    () => { throw new Error("network"); },
  ]) {
    const clock = fakeReplication(); let calls = 0;
    await assert.rejects(verifyLatest(identity, { ...clock, fetcher: async () => { calls++; return response(); } }));
    assert.equal(calls, 1); assert.equal(clock.waits.length, 0);
  }
});

test("extended version wait never retries unsafe metadata, transport or artifact failures; default remains one read", async () => {
  for (const fetcher of [
    mock({ ...metadata, name: "other" }), mock({ ...metadata, version: "1.2.4" }),
    mock({ ...metadata, dist: { ...metadata.dist, integrity: "sha512-wrong" } }),
    mock({ ...metadata, gitHead: "b".repeat(40) }),
    mock({ ...metadata, dist: { ...metadata.dist, tarball: "https://evil.test/a.tgz" } }),
    mock(metadata, Buffer.from("wrong bytes")),
    async () => json("version not found: 9.9.9", 404),
    async () => new Response("not json", { headers: { "content-type": "application/json" } }),
    async (url: Parameters<typeof fetch>[0]) => String(url).endsWith(".tgz") ? json({}, 503) : json(metadata),
    ...[401, 403, 429, 500, 503].map(status => async () => json({}, status)),
    async () => { throw new Error("network"); },
  ] as (typeof fetch)[]) {
    const clock = fakeReplication(); let calls = 0;
    await assert.rejects(verifyRegistry(identity, bytes, { ...clock, fetcher: async (url, init) => { calls++; return fetcher(url, init); } }));
    assert.ok(calls === 1 || calls === 2); assert.equal(clock.waits.length, 0);
  }
  let calls = 0;
  await assert.rejects(verifyRegistry(identity, bytes, { fetcher: async () => { calls++; return json({ error: "Not found" }, 404); } }), recovery);
  assert.equal(calls, 1);
  const clock = fakeReplication();
  await assert.rejects(verifyLatest(identity, { ...clock, attempts: 3, fetcher: mock({ ...manifest, version: "1.2.2" }) }), recovery);
  assert.equal(clock.waits.length, 2);
  for (const attempts of [0, -1, 1.5, REPLICATION_ATTEMPTS + 1]) {
    await assert.rejects(verifyRegistry(identity, bytes, { attempts, fetcher: mock() }), /Invalid retry bound/);
    await assert.rejects(verifyLatest(identity, { attempts, fetcher: mock() }), /Invalid retry bound/);
  }
});

test("new publication cannot downgrade latest; verified historical reruns cannot move latest", () => {
  assert.deepEqual(publicationPlan(false, "1.2.3", "1.2.2"), { publish: true });
  assert.deepEqual(publicationPlan(true, "1.2.3", "2.0.0"), { publish: false });
  assert.deepEqual(publicationPlan(true, "1.2.3", "1.2.3"), { publish: false });
  assert.throws(() => publicationPlan(false, "1.2.3", "1.2.3"));
  assert.throws(() => publicationPlan(false, "1.2.3", "2.0.0"));
  assert.throws(() => publicationPlan(false, "1.2.3", "1.2.3-rc.1"));
  assert.deepEqual(publicationPlan(false, "1.10.0", "1.9.0"), { publish: true });
});

const ghResponse = (status: number, body: unknown) => `HTTP/2.0 ${status} Test\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`;
const assetNames = ["cliproxy-usage-1.2.3.tgz", "release-record.json"];
const release = { id: 1, tag_name: identity.tag, target_commitish: identity.commit, draft: true, prerelease: false, assets: assetNames.map((name, i) => ({ id: i + 2, name, state: "uploaded" })) };
test("authenticated complete page discovery finds drafts and rejects ambiguous or malformed lists", () => {
  const other = { id: 10, tag_name: "v0.1.0" };
  assert.equal(githubReleaseId(JSON.stringify([[]]), identity), undefined);
  assert.equal(githubReleaseId(JSON.stringify([[other], [release]]), identity), release.id);
  for (const pages of [[], {}, null, [null], [[null]], [[{ id: "1", tag_name: identity.tag }]],
    [[{ id: 0, tag_name: identity.tag }]], [[{ id: 1 }]], [[release], [release]],
    [[release, { ...release, id: 2 }]], { message: "forbidden" }, [[other], "truncated page"]]) {
    assert.throws(() => githubReleaseId(JSON.stringify(pages), identity));
  }
  assert.throws(() => githubReleaseId("not json", identity));
});

test("identified GitHub release must match ID/tag/assets; lookup404 never means absence", () => {
  assert.throws(() => githubState(ghResponse(404, { message: "Not Found" }), false, identity, false, false));
  for (const status of [401, 403, 429, 500]) assert.throws(() => githubState(ghResponse(status, { message: "Not Found" }), false, identity, false, false));
  assert.throws(() => githubState("", false, identity, false, false));
  assert.throws(() => githubState(ghResponse(404, {}), false, identity, false, false));
  assert.throws(() => githubState(ghResponse(200, release), true, identity, false, true, 99));
  const state = githubState(ghResponse(200, release), true, identity, false, true, release.id);
  assert.equal(state.exists, true); assert.equal(state.draft, true);
  assert.deepEqual(state.assets, release.assets.map(({ id, name }) => ({ id, name })));
  for (const bad of [
    { ...release, tag_name: "v1.2.4" }, { ...release, target_commitish: "main" }, { ...release, prerelease: true },
    { ...release, assets: [...release.assets, release.assets[0]] },
    { ...release, assets: [{ ...release.assets[0], id: "../../bad" }] },
    { ...release, assets: [] }, { ...release, draft: false },
  ]) assert.throws(() => githubState(ghResponse(200, bad), true, identity, false, true));
  assert.equal(githubState(ghResponse(200, { ...release, draft: false }), true, identity, true, true).draft, false);
});

test("job-level release environment does not use runner-only contexts", () => {
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const jobEnv = /^    env:\n([\s\S]*?)^    steps:/m.exec(publish);
  assert.ok(jobEnv);
  assert.doesNotMatch(jobEnv[1], /\$\{\{\s*runner\./);
  assert.match(publish, /RELEASE_DIR=%s\/release-artifact/);
  assert.match(publish, /"\$RUNNER_TEMP"/);
});

test("draft keeps generated release notes and public finalization does not overwrite them", () => {
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  assert.match(publish, /--generate-notes/);
  const final = publish.slice(publish.indexOf("- name: Finalize verified release"));
  assert.doesNotMatch(final, /--notes(?:[=\s]|-file)/);
});

test("workflow wiring: one orchestrator, isolated SDK checks, draft before tgz publish, verify before public", () => {
  const publish = readFileSync(new URL("../.github/workflows/publish.yml", import.meta.url), "utf8");
  const bump = readFileSync(new URL("../.github/workflows/bump-version.yml", import.meta.url), "utf8");
  assert.throws(() => readFileSync(new URL("../.github/workflows/release.yml", import.meta.url)));
  assert.match(publish, /group: production-release/); assert.match(publish, /cancel-in-progress: false/);
  assert.match(publish, /\["0.80.10", "1.3.0"\]/); assert.match(publish, /needs:.*test/);
  assert.match(publish, /ref: \$\{\{ github.ref \}\}/); assert.doesNotMatch(publish, /ref:.*inputs.tag/);
  assert.match(publish, /npm install --global npm@12.2.0/);
  assert.match(publish, /gh --version/);
  assert.equal((publish.match(/node scripts\/release\.ts gh-probe/g) ?? []).length, 2);
  assert.doesNotMatch(publish, /releases\/tags\//);
  assert.equal((publish.match(/NODE_AUTH_TOKEN:/g) ?? []).length, 1);
  assert.match(publish, /id-token: write/); assert.match(publish, /npm publish "\$ARTIFACT".*--provenance/);
  assert.doesNotMatch(publish, /--clobber|npm view|npm publish --access/);
  const order = ["release.ts gate", "release.ts pack", "release.ts plan", "Stage recoverable draft", "npm publish", "release.ts verify", "Finalize verified release"].map(s => publish.indexOf(s));
  assert.ok(order.every((value, i) => value >= 0 && (i === 0 || value > order[i - 1])), order.join(","));
  assert.match(bump, /github.ref != 'refs\/heads\/main'/);
  assert.match(bump, /persist-credentials: false/);
  assert.ok(bump.indexOf("gh auth setup-git") < bump.indexOf("git push --atomic"));
  assert.ok(bump.indexOf("npm test") < bump.indexOf('npm version "$VERSION_BUMP"'));
  assert.match(bump, /git push --atomic origin HEAD:refs\/heads\/main "refs\/tags\/\$tag"/);
  assert.match(bump, /gh workflow run Publish --ref "\$tag" -f tag="\$tag"/);
  assert.doesNotMatch(bump, /gh workflow run Release|--force|--follow-tags/);
});
