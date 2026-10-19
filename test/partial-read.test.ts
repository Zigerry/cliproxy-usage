import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { readAccounts } from "../src/usage.js";

const config = { ...structuredClone(DEFAULT_SETTINGS), managementUrl: "https://synthetic.invalid", managementKey: "synthetic-only" };

test("DeepSeek read guard retains mixed usable balances but rejects all-malformed shapes", async (t) => {
	for (const [infos, incomplete, error, amount] of [
		[[{ currency: "USD", total_balance: "0" }, null], true, false, 0],
		[[{ currency: "USD", total_balance: "-1" }, { currency: "CNY", total_balance: "bad" }], true, false, -1],
		[[null], undefined, true, undefined],
		[[{}, null], undefined, true, undefined],
		[[{ currency: "USD" }], true, false, undefined],
		[[], undefined, false, undefined],
		[undefined, undefined, false, undefined],
		[null, undefined, true, undefined],
		[{}, undefined, true, undefined],
	] as const) {
		t.mock.method(globalThis, "fetch", async (input: unknown) => Response.json(String(input).endsWith("/openai-compatibility")
			? { "openai-compatibility": [{ "base-url": "https://api.deepseek.com", "auth-index": "a" }] }
			: { status_code: 200, body: infos === undefined ? {} : { balance_infos: infos } }));
		const result = await readAccounts(config, { providers: ["deepseek"] });
		const found = result.providers[0]!;
		if (found.discovery !== "success") assert.fail(found.error);
		const item = found.items[0]!;
		assert.equal(Boolean(item.error), error, JSON.stringify(infos));
		assert.equal(item.incomplete, incomplete, JSON.stringify(infos));
		assert.equal(item.balance?.amounts[0]?.amount, amount);
		assert.equal(item.failure?.category, error ? "invalid-response" : undefined);
		t.mock.restoreAll();
	}
});

test("Codex header fallback only retains incompleteness from a supplied malformed slot", async (t) => {
	for (const [body, incomplete] of [[{}, undefined], [{ rate_limit: { primary_window: null } }, undefined],
		[{ rate_limit: { primary_window: { used_percent: "bad" } } }, true]] as const) {
		t.mock.method(globalThis, "fetch", async (input: unknown) => Response.json(String(input).endsWith("/auth-files")
			? { files: [{ provider: "codex", auth_index: "a" }] }
			: { status_code: 200, body, header: { "x-codex-primary-used-percent": ["0"] } }));
		const found = (await readAccounts(config, { providers: ["codex"] })).providers[0]!;
		if (found.discovery !== "success") assert.fail(found.error);
		assert.deepEqual(found.items[0]?.windows, [{ label: "limit", used: 0 }]);
		assert.equal(found.items[0]?.incomplete, incomplete);
		assert.equal(found.items[0]?.error, undefined);
		t.mock.restoreAll();
	}
});

test("Codex unusable supplied header quota stays unknown/incomplete rather than becoming zero", async (t) => {
	for (const value of ["bad", "", "-1", "Infinity"]) {
		t.mock.method(globalThis, "fetch", async (input: unknown) => Response.json(String(input).endsWith("/auth-files")
			? { files: [{ provider: "codex", auth_index: "a" }] }
			: { status_code: 200, body: {}, header: { "x-codex-primary-used-percent": [value] } }));
		const found = (await readAccounts(config, { providers: ["codex"] })).providers[0]!;
		if (found.discovery !== "success") assert.fail(found.error);
		assert.deepEqual(found.items[0]?.windows, []);
		assert.equal(found.items[0]?.incomplete, true);
		assert.equal(found.items[0]?.error, undefined);
		t.mock.restoreAll();
	}
});
