import assert from "node:assert/strict";
import test from "node:test";
import { parseClaude, parseCodex, parseDeepSeek, parseGrok, parseKimi } from "../src/parsers.js";

const cases = [
	{ name: "Claude", parse: parseClaude,
		valid: { seven_day: { utilization: "0", resets_at: "bad" } },
		mixed: { seven_day: { utilization: "0" }, five_hour: { utilization: "bad" } },
		optional: { seven_day: { utilization: 0 }, five_hour: null },
		invalid: (value: unknown) => ({ five_hour: { utilization: value } }),
		empty: {},
	},
	{ name: "Codex", parse: parseCodex,
		valid: { rate_limit: { primary_window: { used_percent: "0", limit_window_seconds: "bad", reset_at: "bad" } } },
		mixed: { rate_limit: { primary_window: { used_percent: "0" }, secondary_window: { used_percent: "bad" } } },
		optional: { rate_limit: { primary_window: { used_percent: 0 }, secondary_window: null } },
		invalid: (value: unknown) => ({ rate_limit: { primary_window: { used_percent: value } } }),
		empty: {},
	},
	{ name: "Kimi", parse: parseKimi,
		valid: { usage: { limit: "100", used: "0", resetTime: "bad" }, limits: [{ window: { duration: 5, timeUnit: "bad" }, detail: { limit: 100, remaining: 100 } }] },
		mixed: { usage: { limit: "100", used: "0" }, limits: [{ detail: { limit: 100, used: "bad" } }] },
		optional: { usage: { limit: 100, used: 0 }, limits: null },
		invalid: (value: unknown) => ({ usage: { limit: 100, used: value } }),
		empty: {},
	},
] as const;
for (const fixture of cases) {
	test(`${fixture.name} keeps complete zero quota and optional null siblings complete`, () => {
		for (const body of [fixture.valid, fixture.optional]) {
			const parsed = fixture.parse(body);
			assert.ok(parsed.windows.length > 0);
			assert.equal(parsed.windows[0]?.used, 0);
			assert.equal(parsed.incomplete, undefined);
		}
		assert.equal(fixture.parse(fixture.empty).incomplete, undefined);
		assert.deepEqual(fixture.parse(fixture.empty).windows, []);
	});
	test(`${fixture.name} retains valid siblings and reports supplied unusable quota`, () => {
		const parsed = fixture.parse(fixture.mixed);
		assert.equal(parsed.incomplete, true);
		assert.equal(parsed.windows.length, 1);
		assert.equal(parsed.windows[0]?.used, 0);
	});
	test(`${fixture.name} rejects negative/nonfinite quota, without treating over-100 as missing`, () => {
		for (const value of [-1, "-1", "bad", Infinity, 1e309, undefined, null]) {
			const parsed = fixture.parse(fixture.invalid(value));
			assert.deepEqual(parsed.windows, [], String(value));
			assert.equal(parsed.incomplete, true, String(value));
		}
		const parsed = fixture.parse(fixture.invalid(150));
		assert.equal(parsed.windows[0]?.used, 150);
		assert.equal(parsed.incomplete, undefined);
	});
}

test("DeepSeek keeps finite zero/negative balances and identifies malformed sibling entries", () => {
	for (const amount of ["0", -5, 10]) {
		const parsed = parseDeepSeek({ balance_infos: [{ currency: "USD", total_balance: amount }] });
		assert.equal(parsed.incomplete, undefined);
		assert.equal(parsed.balance?.amounts[0]?.amount, Number(amount));
	}
	for (const bad of [null, 1, [], {}, { currency: "CNY", total_balance: "bad" }, { currency: "", total_balance: 1 }, { currency: "CNY", total_balance: Infinity }]) {
		const parsed = parseDeepSeek({ balance_infos: [{ currency: "USD", total_balance: "0" }, bad] });
		assert.equal(parsed.incomplete, true);
		assert.deepEqual(parsed.balance?.amounts, [{ currency: "USD", amount: 0 }]);
	}
	for (const body of [{}, { balance_infos: [] }]) assert.equal(parseDeepSeek(body).incomplete, undefined);
	assert.equal(parseDeepSeek({ balance_infos: [{ currency: "USD" }] }).incomplete, true);
});

test("Grok only classifies supplied weekly quota, including zero and over-100", () => {
	for (const value of [0, "0", 150]) {
		const parsed = parseGrok({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "bad" }, creditUsagePercent: value } });
		assert.equal(parsed.windows[0]?.used, Number(value));
		assert.equal(parsed.incomplete, undefined);
	}
	for (const value of [-1, "bad", undefined, null, Infinity]) {
		const parsed = parseGrok({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" }, creditUsagePercent: value } });
		assert.deepEqual(parsed.windows, []);
		assert.equal(parsed.incomplete, true);
	}
	for (const body of [{}, { config: null }, { config: { currentPeriod: null } }, { config: { currentPeriod: { type: "unknown" }, creditUsagePercent: "bad" } }]) {
		assert.deepEqual(parseGrok(body), { windows: [] });
	}
});

test("null optional windows and quota containers do not invent incompleteness", () => {
	for (const parsed of [parseClaude({ seven_day: null, five_hour: null }), parseCodex({ rate_limit: null }),
		parseCodex({ rate_limit: { primary_window: null, secondary_window: null } }), parseKimi({ usage: null, limits: null })]) {
		assert.deepEqual(parsed, { windows: [] });
	}
});

test("Kimi retains legacy/remaining fallbacks, detects malformed entries and overflowing ratios", () => {
	const parsed = parseKimi({ limits: [{ limit: 200, remaining: 150 }, null, { detail: { limit: 1e-308, used: 1e308 } }] });
	assert.equal(parsed.incomplete, true);
	assert.equal(parsed.windows[0]?.used, 25);
	assert.equal(parsed.windows.length, 1);
	for (const body of [{ usage: { limit: 1e-308, used: 1e308 } }, { limits: {} }, { usage: "bad" }]) {
		assert.deepEqual(parseKimi(body).windows, []);
		assert.equal(parseKimi(body).incomplete, true);
	}
});

test("malformed supplied windows retain sibling quotas without inventing optional ones", () => {
	for (const malformed of [false, 1, "bad", [], {}]) {
		for (const parsed of [
			parseClaude({ seven_day: { utilization: 25 }, five_hour: malformed }),
			parseCodex({ rate_limit: { primary_window: { used_percent: 25 }, secondary_window: malformed } }),
			parseKimi({ usage: { limit: 100, used: 25 }, limits: [malformed] }),
		]) {
			assert.equal(parsed.windows.length, 1);
			assert.equal(parsed.windows[0]?.used, 25);
			assert.equal(parsed.incomplete, true);
		}
	}
	assert.equal(parseKimi({ usage: { limit: 1e308, used: -1e-308 } }).incomplete, true);
});
