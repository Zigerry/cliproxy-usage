import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { readAccounts, resolveManagementSource } from "../src/usage.js";
import type { ProviderName, ReadAccountsResult } from "../src/types.js";

function settings() {
	const value = structuredClone(DEFAULT_SETTINGS);
	value.managementUrl = "https://management.example.invalid";
	value.managementKey = "synthetic-only";
	return value;
}

function success(result: ReadAccountsResult, provider: ProviderName) {
	const found = result.providers.find((item) => item.provider === provider);
	assert.ok(found);
	if (found.discovery !== "success") assert.fail(found.error);
	return found.items;
}

function failure(result: ReadAccountsResult, provider: ProviderName) {
	const found = result.providers.find((item) => item.provider === provider);
	assert.ok(found);
	assert.equal(found.discovery, "failure");
	if (found.discovery !== "failure") assert.fail("expected discovery failure");
	assert.ok(found.error);
	return found.error;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

const quota = () => Response.json({ status_code: 200, body: {} });
const official = (entries: unknown) => ({ "openai-compatibility": [{
	name: "same", "base-url": "https://api.deepseek.com/v1", "api-key-entries": entries,
}] });

test("identity is exact, scoped by provider, and never deduplicated by label or missing ID", async (t) => {
	const forwarded: unknown[] = [];
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
		if (String(input).endsWith("/auth-files")) return Response.json({ files: [
			...([" id ", "id", " id ", undefined, "", "  ", 42, undefined] as unknown[])
				.map((auth_index) => ({ auth_index, provider: "codex", name: "same.json", label: "same" })),
			{ auth_index: "id", provider: "kimi", label: "same" },
		] });
		const body = JSON.parse(String(init?.body));
		forwarded.push(body.auth_index);
		return quota();
	});
	const result = await readAccounts(settings(), { providers: ["codex", "kimi"] });
	const items = success(result, "codex");
	assert.equal(items.length, 7);
	assert.deepEqual(items.map((item) => item.accountId), [" id ", "id", undefined, undefined, undefined, undefined, undefined]);
	assert.ok(items.slice(2).every((item) => item.error === "missing remote auth_index"));
	assert.ok(items.slice(2).every((item) => !Object.hasOwn(item, "accountId")));
	assert.equal(success(result, "kimi")[0]?.accountId, "id");
	assert.deepEqual(forwarded, [" id ", "id", "id"]);
	assert.equal(JSON.stringify(result).includes("synthetic-only"), false);
});

test("unavailable accounts keep identity and successful discovery includes every query error", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		if (calls === 1) return Response.json({ files: [
			{ auth_index: "a", provider: "codex", unavailable: true, status_message: "offline" },
			{ auth_index: "b", provider: "codex" },
		] });
		return Response.json({ status_code: 500 });
	});
	const result = await readAccounts(settings(), { providers: ["codex"] });
	assert.equal(result.managementAuthFailed, false);
	assert.deepEqual(success(result, "codex").map(({ accountId, error }) => ({ accountId, error })), [
		{ accountId: "a", error: "account unavailable" }, { accountId: "b", error: "HTTP 500" },
	]);
	assert.equal(calls, 2);
});

test("auth-files and DeepSeek discovery failures are independent in either direction", async (t) => {
	for (const failed of ["/auth-files", "/openai-compatibility"]) {
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			const url = String(input);
			if (url.endsWith(failed)) return new Response("", { status: 500 });
			if (url.endsWith("/auth-files")) return Response.json({ files: [{ provider: "codex", auth_index: "c" }] });
			if (url.endsWith("/openai-compatibility")) return Response.json(official([{ "auth-index": "d" }]));
			return Response.json({ status_code: 200, body: { is_available: true, balance_infos: [{ currency: "CNY", total_balance: "1" }] } });
		});
		const result = await readAccounts(settings(), { providers: ["codex", "deepseek"] });
		failure(result, failed === "/auth-files" ? "codex" : "deepseek");
		assert.equal(success(result, failed === "/auth-files" ? "deepseek" : "codex").length, 1);
		assert.equal(result.managementAuthFailed, false);
		t.mock.restoreAll();
	}
});

test("empty lists are authoritative successes and DeepSeek-only skips auth-files", async (t) => {
	const urls: string[] = [];
	t.mock.method(globalThis, "fetch", async (input: unknown) => {
		urls.push(String(input));
		return Response.json(String(input).endsWith("/auth-files") ? { files: [] } : { "openai-compatibility": [] });
	});
	assert.deepEqual(success(await readAccounts(settings(), { providers: ["deepseek"] }), "deepseek"), []);
	assert.equal(urls.length, 1);
	assert.ok(urls[0]?.endsWith("/openai-compatibility"));
	assert.deepEqual(success(await readAccounts(settings(), { providers: ["codex"] }), "codex"), []);
});

test("malformed auth-files lists fail closed instead of dropping entries", async (t) => {
	for (const value of [null, {}, { files: null }, { files: {} }, { files: [null] },
		{ files: ["bad"] }, { files: [{}] }, { files: [{ provider: 42 }] },
		{ files: [{ provider: "codex", auth_index: "a" }, { provider: "codex", name: 12 }] }]) {
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(value); });
		failure(await readAccounts(settings(), { providers: ["codex"] }), "codex");
		assert.equal(calls, 1);
		t.mock.restoreAll();
	}
});

test("malformed DeepSeek collections and official api-key-entries fail closed", async (t) => {
	for (const value of [null, {}, { "openai-compatibility": {} }, { "openai-compatibility": [null] },
		{ "openai-compatibility": [{}] }, official(null), official({}), official("bad"),
		{ "openai-compatibility": [{ "base-url": "https://api.deepseek.com", "auth-index": "d", "api-key-entries": null }] },
		{ "openai-compatibility": [{ "base-url": "https://api.deepseek.com" }] },
		official([null]), official(["bad"]), official([{ "auth-index": "d" }, null])]) {
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json(value); });
		failure(await readAccounts(settings(), { providers: ["deepseek"] }), "deepseek");
		assert.equal(calls, 1);
		t.mock.restoreAll();
	}
});

test("DeepSeek invalid identities remain discovered and never reach api-call", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		return Response.json(official([{}, { "auth-index": 123 }, { "auth-index": " " }]));
	});
	const items = success(await readAccounts(settings(), { providers: ["deepseek"] }), "deepseek");
	assert.equal(items.length, 3);
	assert.ok(items.every((item) => !item.accountId && item.error === "missing remote auth_index"));
	assert.equal(calls, 1);
});

test("DeepSeek hostname safety and disabled/unknown entries remain normal skips", async (t) => {
	t.mock.method(globalThis, "fetch", async () => Response.json({ "openai-compatibility": [
		{ disabled: true },
		{ "base-url": "https://api.deepseek.com.evil.invalid", "api-key-entries": null },
		{ "base-url": "https://relay.invalid", "auth-index": "x" },
	] }));
	assert.deepEqual(success(await readAccounts(settings(), { providers: ["deepseek"] }), "deepseek"), []);
});

test("a fixed source is used without rereading the provider file or leaking keys", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "usage-source-"));
	try {
		const path = join(dir, "provider.json");
		const value = settings();
		value.managementUrl = "";
		await writeFile(path, JSON.stringify({ baseUrl: "https://first.example.invalid/v1" }));
		const source = await resolveManagementSource(value, path);
		await writeFile(path, JSON.stringify({ baseUrl: "https://changed.example.invalid/v1" }));
		const urls: string[] = [];
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			urls.push(String(input));
			return Response.json({ files: [] });
		});
		const result = await readAccounts(value, { source, providerConfigPath: path, providers: ["codex"] });
		assert.deepEqual(urls, ["https://first.example.invalid/v0/management/auth-files"]);
		assert.deepEqual(success(result, "codex"), []);
		assert.equal(JSON.stringify({ source, result }).includes(value.managementKey), false);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test("the fixed URL and key cannot change between discovery and query", async (t) => {
	const value = settings();
	const source = { managementUrl: value.managementUrl, managementKeyConfigured: true };
	const requests: Array<{ url: string; authorization: string | null }> = [];
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
		requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
		if (String(input).endsWith("/auth-files")) {
			source.managementUrl = "https://changed.example.invalid";
			value.managementKey = "synthetic-changed";
			return Response.json({ files: [{ provider: "codex", auth_index: "a" }] });
		}
		return quota();
	});
	await readAccounts(value, { source, providers: ["codex"] });
	assert.ok(requests.every((request) => request.url.startsWith("https://management.example.invalid/")));
	assert.ok(requests.every((request) => request.authorization === "Bearer synthetic-only"));
});

test("management 401/403 during either discovery stops remaining HTTP", async (t) => {
	for (const failed of ["/auth-files", "/openai-compatibility"]) {
		const urls: string[] = [];
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			const url = String(input);
			urls.push(url);
			return url.endsWith(failed) ? new Response("", { status: 403 })
				: Response.json({ files: [{ provider: "codex", auth_index: "c" }] });
		});
		const result = await readAccounts(settings(), { providers: ["codex", "deepseek"] });
		assert.equal(result.managementAuthFailed, true);
		failure(result, "deepseek");
		if (failed === "/auth-files") failure(result, "codex");
		else assert.ok(success(result, "codex")[0]?.error);
		assert.equal(urls.length, failed === "/auth-files" ? 1 : 2);
		t.mock.restoreAll();
	}
});

test("concurrent query rejection distinguishes Management auth from official provider 401", async (t) => {
	for (const management of [true, false]) {
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => {
			calls++;
			if (calls === 1) return Response.json({ files: ["a", "b"].map((auth_index) => ({ provider: "codex", auth_index })) });
			return management ? new Response("", { status: 401 }) : Response.json({ status_code: 401 });
		});
		const result = await readAccounts(settings(), { providers: ["codex"] });
		assert.equal(result.managementAuthFailed, management);
		assert.equal(success(result, "codex").length, 2);
		assert.ok(success(result, "codex").every((item) => item.error));
		assert.equal(calls, 3);
		t.mock.restoreAll();
	}
});

test("account queries start concurrently and retain discovery order on mixed auth failure/success", async (t) => {
	const first = deferred<Response>();
	const firstStarted = deferred<void>();
	let secondStarted = false;
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
		if (String(input).endsWith("/auth-files")) return Response.json({ files: ["a", "b"].map((auth_index) => ({ provider: "codex", auth_index })) });
		if (JSON.parse(String(init?.body)).auth_index === "a") {
			firstStarted.resolve();
			return first.promise;
		}
		secondStarted = true;
		return Response.json({ status_code: 200, body: { rate_limit: {
			primary_window: { used_percent: 20, limit_window_seconds: 604800 },
		} } });
	});
	const reading = readAccounts(settings(), { providers: ["codex"] });
	await firstStarted.promise;
	await new Promise<void>((resolve) => setImmediate(resolve));
	const concurrent = secondStarted;
	first.resolve(new Response("", { status: 401 }));
	const result = await reading;
	assert.equal(concurrent, true, "second request must start before the first returns");
	const items = success(result, "codex");
	assert.deepEqual(items.map((item) => item.accountId), ["a", "b"]);
	assert.ok(items[0]?.error);
	assert.equal(items[1]?.error, undefined);
	assert.equal(items[1]?.windows[0]?.used, 20);
	assert.equal(result.managementAuthFailed, true);
});

test("already aborted reads throw the parent's exact reason and perform no HTTP", async (t) => {
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; return quota(); });
	const controller = new AbortController();
	const reason = { cancellation: true };
	controller.abort(reason);
	await assert.rejects(readAccounts(settings(), { signal: controller.signal }), (error) => error === reason);
	assert.equal(calls, 0);
});

for (const stage of ["discovery-fetch", "discovery-body", "quota-fetch", "quota-body"] as const) {
	test(`parent abort promptly releases ignored ${stage}, consumes late rejection, and starts no more HTTP`, async (t) => {
		const blocked = deferred<Response>();
		const body = deferred<unknown>();
		const entered = deferred<void>();
		const controller = new AbortController();
		const reason = new Error("synthetic parent cancellation");
		let calls = 0;
		let requestSignal: AbortSignal | undefined;
		t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
			calls++;
			requestSignal = init?.signal ?? undefined;
			const target = stage.startsWith("discovery") ? calls === 1 : calls === 2;
			if (!target) return Response.json({ files: [{ provider: "codex", auth_index: "a" }] });
			if (stage.endsWith("fetch")) { entered.resolve(); return blocked.promise; }
			return { ok: true, json: () => { entered.resolve(); return body.promise; } } as Response;
		});
		const reading = readAccounts(settings(), { providers: ["codex"], signal: controller.signal });
		await entered.promise;
		controller.abort(reason);
		await assert.rejects(reading, (error) => error === reason);
		assert.equal(requestSignal?.aborted, true);
		assert.equal(calls, stage.startsWith("discovery") ? 1 : 2);
		if (stage.endsWith("fetch")) blocked.reject(new Error("late fetch rejection"));
		else body.reject(new Error("late body rejection"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, stage.startsWith("discovery") ? 1 : 2);
	});
}

test("late discovery resolution after cancellation cannot initiate another network stage", async (t) => {
	const blocked = deferred<Response>();
	const entered = deferred<void>();
	const controller = new AbortController();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => { calls++; entered.resolve(); return blocked.promise; });
	const reading = readAccounts(settings(), { signal: controller.signal });
	await entered.promise;
	controller.abort("stop");
	await assert.rejects(reading, (error) => error === "stop");
	let bodyReads = 0;
	blocked.resolve({ ok: true, json: async () => {
		bodyReads++;
		return { files: [{ provider: "codex", auth_index: "a" }] };
	} } as Response);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(calls, 1);
	assert.equal(bodyReads, 0);
});

test("one 10-second request budget covers fetch and delayed JSON, even when body ignores abort", async (t) => {
	for (const stage of ["discovery", "quota"] as const) {
		const timeout = new AbortController();
		const body = deferred<unknown>();
		const entered = deferred<void>();
		const budgets: number[] = [];
		let calls = 0;
		t.mock.method(AbortSignal, "timeout", (milliseconds: number) => { budgets.push(milliseconds); return timeout.signal; });
		t.mock.method(globalThis, "fetch", async () => {
			calls++;
			if (stage === "quota" && calls === 1) return Response.json({ files: [{ provider: "codex", auth_index: "a" }] });
			return { ok: true, json: () => { entered.resolve(); return body.promise; } } as Response;
		});
		const reading = readAccounts(settings(), { providers: ["codex"] });
		await entered.promise;
		timeout.abort(new DOMException("synthetic body timeout", "TimeoutError"));
		const result = await reading;
		assert.equal(result.managementAuthFailed, false);
		if (stage === "discovery") assert.match(failure(result, "codex"), /management request timed out/);
		else assert.match(success(result, "codex")[0]?.error ?? "", /management request timed out/);
		assert.equal(result.management?.failures[0]?.category, "timeout");
		assert.deepEqual(budgets, stage === "discovery" ? [10_000] : [10_000, 10_000]);
		body.reject(new Error("late timed-out body rejection"));
		await new Promise<void>((resolve) => setImmediate(resolve));
		t.mock.restoreAll();
	}
});
