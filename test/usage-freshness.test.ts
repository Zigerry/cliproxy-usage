import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { readAccounts } from "../src/usage.js";

function settings() {
	const value = structuredClone(DEFAULT_SETTINGS);
	value.managementUrl = "https://management.example.invalid";
	value.managementKey = "synthetic-only";
	return value;
}

test("read outcomes distinguish actually queried accounts from skipped entries", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: unknown) => {
		if (String(input).endsWith("/auth-files")) return Response.json({ files: [
			{ provider: "codex", auth_index: "unavailable", unavailable: true, status_message: "Bearer must-not-be-displayed" },
			{ provider: "codex", label: "missing" },
			{ provider: "codex", auth_index: "queried" },
		] });
		return Response.json({ status_code: 503 });
	});
	const result = await readAccounts(settings(), { providers: ["codex"] });
	const provider = result.providers[0]!;
	assert.equal(provider.discovery, "success");
	if (provider.discovery !== "success") return;
	assert.deepEqual(provider.items.map((item) => item.queried), [false, false, true]);
	assert.equal(JSON.stringify(result).includes("must-not-be-displayed"), false);
});

test("Management discovery rejection does not pretend skipped account queries occurred", async (t) => {
	t.mock.method(globalThis, "fetch", async (input: unknown) => {
		if (String(input).endsWith("/auth-files")) return Response.json({ files: [{ provider: "codex", auth_index: "a" }] });
		return new Response("", { status: 401 });
	});
	const result = await readAccounts(settings(), { providers: ["codex", "deepseek"] });
	assert.equal(result.managementAuthFailed, true);
	const provider = result.providers.find((item) => item.provider === "codex")!;
	assert.equal(provider.discovery, "success");
	if (provider.discovery === "success") assert.equal(provider.items[0]?.queried, false);
});

test("DeepSeek valid but missing balance data is unknown; malformed shape is failure; zero is valid", async (t) => {
	for (const [body, error, amount] of [
		[{}, false, undefined],
		[{ is_available: true }, false, undefined],
		[{ balance_infos: [] }, false, undefined],
		[{ balance_infos: [{ currency: "USD" }] }, false, undefined],
		[null, true, undefined],
		[[], true, undefined],
		[{ balance_infos: null }, true, undefined],
		[{ balance_infos: [null] }, true, undefined],
		[{ is_available: "false", balance_infos: [] }, true, undefined],
		[{ balance_infos: [{ currency: "USD", total_balance: "0" }] }, false, 0],
	] as const) {
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input).endsWith("/openai-compatibility")) return Response.json({ "openai-compatibility": [{
				"base-url": "https://api.deepseek.com", "auth-index": "d",
			}] });
			return Response.json({ status_code: 200, body });
		});
		const result = await readAccounts(settings(), { providers: ["deepseek"] });
		const provider = result.providers[0]!;
		assert.equal(provider.discovery, "success");
		if (provider.discovery !== "success") return;
		const item = provider.items[0]!;
		assert.equal(Boolean(item.error), error);
		assert.equal(item.balance?.amounts[0]?.amount, amount);
		assert.equal(item.queried, true);
		t.mock.restoreAll();
	}
});

test("malformed management JSON does not expose response fragments in error messages", async (t) => {
	t.mock.method(globalThis, "fetch", async () => new Response("Bearer confidential-body", {
		headers: { "Content-Type": "application/json" },
	}));
	const result = await readAccounts(settings(), { providers: ["codex"] });
	assert.equal(JSON.stringify(result).includes("confidential-body"), false);
	assert.equal(result.providers[0]?.discovery, "failure");
});
