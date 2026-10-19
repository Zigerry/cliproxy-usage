import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import type { AccountUsage, ProviderName, ReadAccountsResult } from "../src/types.js";
import { ManagementHttpError, readAccounts, validateManagementAccess } from "../src/usage.js";

const now = Date.UTC(2026, 0, 1);
function settings() {
	return { ...structuredClone(DEFAULT_SETTINGS), managementUrl: "https://management.example.invalid", managementKey: "secret-must-not-leak" };
}
function items(result: ReadAccountsResult, provider: ProviderName = "codex"): AccountUsage[] {
	const found = result.providers.find((item) => item.provider === provider);
	assert.equal(found?.discovery, "success");
	return found?.discovery === "success" ? found.items : [];
}
const authFiles = () => Response.json({ files: [{ provider: "codex", auth_index: "a" }] });
const deepseek = () => Response.json({ "openai-compatibility": [{ "base-url": "https://api.deepseek.com", "auth-index": "d" }] });

for (const scope of ["management", "provider"] as const) {
	for (const status of [429, 503, 401]) {
		test(`${scope} HTTP ${status} has safe failure facts and response-time Retry-After`, async (t) => {
			t.mock.method(Date, "now", () => now);
			t.mock.method(globalThis, "fetch", async (input: unknown) => {
				if (String(input).endsWith("/auth-files")) return authFiles();
				if (scope === "management") return new Response("secret-rawbody", { status, headers: { "rEtRy-AfTeR": "120", "X-Secret": "secret-header" } });
				return Response.json({ status_code: status, header: { "rEtRy-AfTeR": ["120"], "bad header": null, "X-Secret": { raw: "secret-header" } }, body: "secret-rawbody" });
			});
			const result = await readAccounts(settings(), { providers: ["codex"] });
			const expected = { scope, category: status === 429 ? "rate-limit" : status === 503 ? "server" : "auth", status, retryAfterAt: now + 120_000 };
			assert.deepEqual(items(result)[0]?.failure, expected);
			assert.equal(items(result)[0]?.queried, true);
			assert.equal(result.managementAuthFailed, scope === "management" && status === 401);
			assert.deepEqual(result.management, { attempted: true, failures: scope === "management" ? [expected] : [] });
			for (const secret of ["secret-rawbody", "secret-header", "secret-must-not-leak"]) assert.equal(JSON.stringify(result).includes(secret), false);
		});
	}
}

for (const status of [429, 503, 401]) {
	test(`Management discovery ${status} blocks only unstarted work, reporting one completion`, async (t) => {
		t.mock.method(Date, "now", () => now);
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => { calls++; return new Response("", { status, headers: { "Retry-After": "60" } }); });
		const result = await readAccounts(settings(), { providers: ["codex", "deepseek"] });
		assert.equal(calls, 1);
		const [actual, skipped] = result.providers;
		assert.equal(actual?.discovery, "failure");
		assert.equal(skipped?.discovery, "failure");
		if (actual?.discovery !== "failure" || skipped?.discovery !== "failure") return;
		assert.equal(actual.attempted, true);
		assert.equal(skipped.attempted, false);
		assert.deepEqual(skipped.failure, actual.failure);
		assert.deepEqual(result.management, { attempted: true, failures: [actual.failure] });
	});
}

test("a DeepSeek discovery wait marks discovered ordinary accounts unqueried with safe blocking facts", async (t) => {
	t.mock.method(Date, "now", () => now);
	let calls = 0;
	t.mock.method(globalThis, "fetch", async (input: unknown) => {
		calls++;
		return String(input).endsWith("/auth-files") ? authFiles() : new Response("", { status: 503, headers: { "Retry-After": "60" } });
	});
	const result = await readAccounts(settings(), { providers: ["codex", "deepseek"] });
	assert.equal(calls, 2);
	assert.equal(items(result)[0]?.queried, false);
	assert.deepEqual(items(result)[0]?.failure, { scope: "management", category: "server", status: 503, retryAfterAt: now + 60_000 });
	assert.equal(result.management?.failures.length, 1);
});

for (const status of [429, 503]) {
for (const retryAfter of [undefined, "0", "invalid", "Wed, 01 Jan 2025 00:00:00 GMT"]) {
	test(`Management ${status} without future wait (${retryAfter}): only 429 blocks remaining discovery`, async (t) => {
		t.mock.method(Date, "now", () => now);
		let calls = 0;
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			calls++;
			if (String(input).endsWith("/auth-files")) return new Response("", { status, headers: retryAfter ? { "Retry-After": retryAfter } : {} });
			if (String(input).endsWith("/openai-compatibility")) return deepseek();
			return Response.json({ status_code: 200, body: {} });
		});
		const result = await readAccounts(settings(), { providers: ["codex", "deepseek"] });
		assert.equal(calls, status === 429 ? 1 : 3);
		if (status === 503) assert.equal(items(result, "deepseek")[0]?.queried, true);
		else {
			const skipped = result.providers.find((item) => item.provider === "deepseek");
			assert.ok(skipped?.discovery === "failure");
			assert.equal(skipped.attempted, false);
			assert.equal(skipped.failure?.retryAfterAt, undefined);
		}
		assert.deepEqual(result.management, { attempted: true, failures: [{ scope: "management", category: status === 429 ? "rate-limit" : "server", status }] });
	});
}
}

for (const stage of ["discovery", "query"] as const) {
	for (const category of ["network", "timeout"] as const) {
		test(`${stage} ${category} reports exactly one actual Management failure, without unsafe error text`, async (t) => {
			let calls = 0;
			t.mock.method(globalThis, "fetch", async () => {
				calls++;
				if (stage === "query" && calls === 1) return authFiles();
				if (category === "timeout") throw new DOMException("secret-network-text", "TimeoutError");
				throw new Error("secret-network-text");
			});
			const result = await readAccounts(settings(), { providers: ["codex"] });
			const failure = { scope: "management", category };
			assert.deepEqual(result.management, { attempted: true, failures: [failure] });
			if (stage === "query") assert.deepEqual(items(result)[0]?.failure, failure);
			else { const found = result.providers[0]; assert.ok(found?.discovery === "failure"); assert.deepEqual(found.failure, failure); }
			assert.equal(JSON.stringify(result).includes("secret-network-text"), false);
		});
	}
}

test("invalid JSON and invalid discovery shapes are actual invalid-response completions", async (t) => {
	for (const response of [new Response("secret-not-json"), Response.json({ files: null })]) {
		t.mock.method(globalThis, "fetch", async () => response);
		const result = await readAccounts(settings(), { providers: ["codex"] });
		assert.deepEqual(result.management, { attempted: true, failures: [{ scope: "management", category: "invalid-response" }] });
		assert.equal(JSON.stringify(result).includes("secret-not-json"), false);
		t.mock.restoreAll();
	}
});

test("malformed provider success JSON is not a Management failure", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/auth-files") ? authFiles() : Response.json({ status_code: 200, body: "secret-not-json" }));
	const result = await readAccounts(settings(), { providers: ["codex"] });
	assert.deepEqual(result.management, { attempted: true, failures: [] });
	assert.deepEqual(items(result)[0]?.failure, { scope: "provider", category: "invalid-response" });
});

test("safe nested headers ignore malformed unrelated entries on a successful quota response", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/auth-files") ? authFiles() : Response.json({ status_code: 200, body: {}, header: { "bad name": [null], bad: {}, "X-CoDeX-Primary-Used-Percent": ["25"] } }));
	const result = await readAccounts(settings(), { providers: ["codex"] });
	assert.equal(items(result)[0]?.error, undefined);
	assert.deepEqual(items(result)[0]?.windows, [{ label: "limit", used: 25 }]);
});

test("ManagementHttpError remains compatible with setup status checks", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("", { status: 401 }));
	await assert.rejects(validateManagementAccess(settings()), (error) => error instanceof ManagementHttpError && error.status === 401);
});

test("concurrent completions retain all deadlines in stable account order", async (t) => {
	t.mock.method(Date, "now", () => now);
	let finishFirst!: (response: Response) => void;
	const first = new Promise<Response>((resolve) => { finishFirst = resolve; });
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
		if (String(input).endsWith("/auth-files")) return Response.json({ files: ["a", "b"].map((auth_index) => ({ provider: "codex", auth_index })) });
		if (JSON.parse(String(init?.body)).auth_index === "a") return first;
		finishFirst(new Response("", { status: 503, headers: { "Retry-After": "300" } }));
		return new Response("", { status: 429, headers: { "Retry-After": "600" } });
	});
	const result = await readAccounts(settings(), { providers: ["codex"] });
	assert.deepEqual(items(result).map((item) => item.accountId), ["a", "b"]);
	assert.deepEqual(items(result).map((item) => item.failure?.retryAfterAt), [now + 300_000, now + 600_000]);
	assert.deepEqual(result.management?.failures.map((failure) => failure.retryAfterAt).sort(), [now + 300_000, now + 600_000]);
});

for (const header of [undefined, null, [], "Retry-After: 60", { "Retry-After": [{ secret: true }, null, 60] }, { "Retry-After": "bad\nvalue", "bad\nname": "bad\nvalue" }]) {
	test(`malformed nested header ${JSON.stringify(header)} cannot disguise known HTTP 429`, async (t) => {
		t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/auth-files") ? authFiles() : Response.json({ status_code: 429, header, body: "do-not-parse" }));
		const result = await readAccounts(settings(), { providers: ["codex"] });
		assert.deepEqual(items(result)[0]?.failure, { scope: "provider", category: "rate-limit", status: 429 });
		assert.deepEqual(result.management, { attempted: true, failures: [] });
	});
}

test("nested duplicate case-insensitive Retry-After values preserve the longest valid delay", async (t) => {
	t.mock.method(Date, "now", () => now);
	t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/auth-files") ? authFiles() : Response.json({ status_code: 503, header: { "Retry-After": [null, "invalid", "60"], "retry-after": ["120"] } }));
	assert.equal(items(await readAccounts(settings(), { providers: ["codex"] }))[0]?.failure?.retryAfterAt, now + 120_000);
});

for (const status of [400, 403, 404, 500]) {
	test(`nested HTTP ${status} retains distinct failure category`, async (t) => {
		t.mock.method(globalThis, "fetch", async (input: unknown) => String(input).endsWith("/auth-files") ? authFiles() : Response.json({ status_code: status }));
		const result = await readAccounts(settings(), { providers: ["codex"] });
		assert.deepEqual(items(result)[0]?.failure, { scope: "provider", category: status === 403 ? "auth" : status === 500 ? "server" : "http", status });
		assert.equal(result.managementAuthFailed, false);
	});
}

test("each nested server delay starts at its own response, not the slowest account completion", async (t) => {
	let clock = now;
	t.mock.method(Date, "now", () => clock);
	let complete!: (response: Response) => void;
	let started!: () => void;
	const blocked = new Promise<Response>((resolve) => { complete = resolve; });
	const entered = new Promise<void>((resolve) => { started = resolve; });
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
		if (String(input).endsWith("/auth-files")) return Response.json({ files: ["a", "b"].map((auth_index) => ({ provider: "codex", auth_index })) });
		if (JSON.parse(String(init?.body)).auth_index === "a") return Response.json({ status_code: 429, header: { "Retry-After": "60" } });
		started();
		return blocked;
	});
	const reading = readAccounts(settings(), { providers: ["codex"] });
	await entered;
	await new Promise<void>((resolve) => setImmediate(resolve));
	clock += 30_000;
	complete(Response.json({ status_code: 503, header: { "Retry-After": "60" } }));
	const result = await reading;
	assert.deepEqual(items(result).map((item) => item.failure?.retryAfterAt), [now + 60_000, now + 90_000]);
});

for (const successFirst of [true, false]) {
	test(`same-round Management success does not erase failure (successFirst=${successFirst})`, async (t) => {
		t.mock.method(Date, "now", () => now);
		let complete!: (response: Response) => void;
		const blocked = new Promise<Response>((resolve) => { complete = resolve; });
		let started!: () => void;
		const entered = new Promise<void>((resolve) => { started = resolve; });
		const failure = () => new Response("", { status: 503, headers: { "Retry-After": "60" } });
		const success = () => Response.json({ status_code: 200, body: {} });
		t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
			if (String(input).endsWith("/auth-files")) return Response.json({ files: ["a", "b"].map((auth_index) => ({ provider: "codex", auth_index })) });
			if (JSON.parse(String(init?.body)).auth_index === "a") { started(); return blocked; }
			return successFirst ? success() : failure();
		});
		const reading = readAccounts(settings(), { providers: ["codex"] });
		await entered;
		await new Promise<void>((resolve) => setImmediate(resolve));
		complete(successFirst ? failure() : success());
		const result = await reading;
		assert.deepEqual(result.management, { attempted: true, failures: [{ scope: "management", category: "server", status: 503, retryAfterAt: now + 60_000 }] });
		assert.deepEqual(items(result).map((item) => item.queried), [true, true]);
	});
}

for (const duringBody of [false, true]) {
	test(`parent cancellation during ${duringBody ? "body" : "fetch"} is control, not a failure or next discovery`, async (t) => {
		const controller = new AbortController();
		const reason = { parentCancellation: true };
		let enter!: () => void;
		const entered = new Promise<void>((resolve) => { enter = resolve; });
		let finish!: (value: never) => void;
		const blocked = new Promise<never>((resolve) => { finish = resolve; });
		let calls = 0;
		t.mock.method(globalThis, "fetch", async () => {
			calls++;
			if (duringBody) return { ok: true, json: () => { enter(); return blocked; } } as unknown as Response;
			enter(); return blocked;
		});
		const reading = readAccounts(settings(), { providers: ["codex", "deepseek"], signal: controller.signal });
		await entered;
		controller.abort(reason);
		await assert.rejects(reading, (error) => error === reason);
		finish(undefined as never);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(calls, 1);
	});
}

test("request timeout while JSON is blocked reports timeout, not invalid response", async (t) => {
	const timeout = new AbortController();
	t.mock.method(AbortSignal, "timeout", () => timeout.signal);
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => { enter = resolve; });
	t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: () => { enter(); return new Promise(() => {}); } }) as unknown as Response);
	const reading = readAccounts(settings(), { providers: ["codex"] });
	await entered;
	timeout.abort(new DOMException("secret-timeout", "TimeoutError"));
	const result = await reading;
	assert.deepEqual(result.management, { attempted: true, failures: [{ scope: "management", category: "timeout" }] });
	assert.equal(JSON.stringify(result).includes("secret-timeout"), false);
});
