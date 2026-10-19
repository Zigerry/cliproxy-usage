import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { readAccounts } from "../src/usage.js";
import type { ProviderName } from "../src/types.js";

async function withUsageResponse(
	provider: ProviderName,
	body: unknown,
	header: Record<string, string[]> = {},
) {
	const originalFetch = globalThis.fetch;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.managementUrl = "https://management.example.invalid";
	settings.managementKey = "synthetic-only";
	let requests = 0;
	try {
		globalThis.fetch = async (input) => {
			requests++;
			if (String(input).endsWith("/auth-files")) {
				return Response.json({ files: [{ auth_index: "synthetic", provider }] });
			}
			return Response.json({ status_code: 200, body, header });
		};
		const result = await readAccounts(settings, { providers: [provider] });
		assert.equal(result.managementAuthFailed, false);
		assert.equal(result.providers.length, 1);
		const discovery = result.providers[0]!;
		if (discovery.discovery !== "success") assert.fail(discovery.error);
		const items = discovery.items;
		assert.equal(requests, 2);
		assert.equal(items.length, 1);
		assert.equal(items[0]?.error, undefined);
		return items[0]!;
	} finally {
		globalThis.fetch = originalFetch;
	}
}

test("Codex header fallback distinguishes missing/invalid values from real zero", async () => {
	for (const [value, expected] of [
		[undefined, undefined],
		["", undefined],
		[" ", undefined],
		["bad", undefined],
		["NaN", undefined],
		["Infinity", undefined],
		["0", 0],
		["25.5", 25.5],
	] as const) {
		const item = await withUsageResponse("codex", {}, value === undefined
			? {}
			: { "x-codex-primary-used-percent": [value] });
		assert.deepEqual(item.windows, expected === undefined
			? []
			: [{ label: "limit", used: expected }]);
	}
});

test("Codex body windows without a duration keep their own usage and neutral label", async () => {
	const item = await withUsageResponse("codex", {
		rate_limit: { primary_window: {
			used_percent: 100,
			reset_at: "2030-01-01T00:00:00Z",
		} },
	}, { "x-codex-primary-used-percent": ["0"] });
	assert.equal(item.windows[0]?.label, "limit");
	assert.equal(item.windows[0]?.used, 100);
	assert.equal(item.windows[0]?.resetsAt?.toISOString(), "2030-01-01T00:00:00.000Z");
});

test("successful Grok response with no quota number does not fabricate full remaining quota", async () => {
	const item = await withUsageResponse("grok", {
		config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
	});
	assert.deepEqual(item.windows, []);
});
