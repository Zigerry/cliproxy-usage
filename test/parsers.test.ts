import assert from "node:assert/strict";
import test from "node:test";
import {
	durationLabel,
	parseClaude,
	parseCodex,
	parseDeepSeek,
	parseGrok,
	parseKimi,
	toNumber,
} from "../src/parsers.js";

test("toNumber accepts finite numbers and numeric strings", () => {
	assert.equal(toNumber(12.5), 12.5);
	assert.equal(toNumber(" 42 "), 42);
	assert.equal(toNumber(""), undefined);
	assert.equal(toNumber("nope"), undefined);
	assert.equal(toNumber(Number.POSITIVE_INFINITY), undefined);
	assert.equal(toNumber(null), undefined);
});

test("durationLabel renders human-readable window lengths", () => {
	assert.equal(durationLabel(18000), "5h");
	assert.equal(durationLabel(604800), "7d");
	assert.equal(durationLabel(300), "5m");
	assert.equal(durationLabel(7200), "2h");
	assert.equal(durationLabel(172800), "2d");
	assert.equal(durationLabel(90), "90s");
});

test("DeepSeek parses monetary balances without quota windows", () => {
	assert.deepEqual(
		parseDeepSeek({
			is_available: true,
			balance_infos: [
				{ currency: "cny", total_balance: "110.25" },
				{ currency: "USD", total_balance: 5 },
				{ currency: "", total_balance: "invalid" },
			],
		}),
		{
			windows: [],
			incomplete: true,
			balance: {
				available: true,
				amounts: [
					{ currency: "CNY", amount: 110.25 },
					{ currency: "USD", amount: 5 },
				],
			},
		},
	);
	assert.equal(parseDeepSeek({ is_available: false }).balance?.available, false);
});

test("Claude parses optional windows and reset dates", () => {
	const usage = parseClaude({
		five_hour: { utilization: "25", resets_at: "2030-01-01T00:00:00Z" },
		seven_day: null,
	});
	assert.equal(usage.windows.length, 1);
	assert.equal(usage.windows[0]?.label, "5h");
	assert.equal(usage.windows[0]?.used, 25);
	assert.equal(
		usage.windows[0]?.resetsAt?.toISOString(),
		"2030-01-01T00:00:00.000Z",
	);
	assert.deepEqual(parseClaude({}), { windows: [] });
});

test("Claude keeps five-hour and seven-day windows in order", () => {
	const usage = parseClaude({
		five_hour: { utilization: 10 },
		seven_day: { utilization: 60 },
	});
	assert.deepEqual(
		usage.windows.map((window) => [window.label, window.used]),
		[
			["7d", 60],
			["5h", 10],
		],
	);
});

test("Codex classifies windows by duration regardless of slot", () => {
	const usage = parseCodex({
		rate_limit: {
			primary_window: { used_percent: 20, limit_window_seconds: 604800 },
			secondary_window: {
				used_percent: "40",
				limit_window_seconds: 18000,
				reset_at: 1_893_456_000,
			},
		},
	});
	assert.deepEqual(
		usage.windows.map((window) => [window.label, window.used]),
		[
			["7d", 20],
			["5h", 40],
		],
	);
	assert.equal(usage.windows[1]?.resetsAt?.getTime(), 1_893_456_000_000);
});

test("Codex never reports the seven-day window as the session window", () => {
	// Regression: on some plans primary_window IS the 7-day window and
	// secondary_window is null. The old code fell back to windows[0] and
	// displayed the weekly quota as "S" (session).
	const usage = parseCodex({
		rate_limit: {
			primary_window: {
				used_percent: 31,
				limit_window_seconds: 604800,
				reset_at: 1_786_172_582,
			},
			secondary_window: null,
		},
	});
	assert.deepEqual(
		usage.windows.map((window) => window.label),
		["7d"],
	);
	assert.equal(usage.windows[0]?.used, 31);
});

test("Codex never infers window length from reset distance", (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2030, 0, 1) });
	const soon = Date.UTC(2030, 0, 1, 1) / 1000;
	const later = Date.UTC(2030, 0, 5) / 1000;
	const usage = parseCodex({
		rate_limit: {
			primary_window: { used_percent: 10, reset_at: soon },
			secondary_window: { used_percent: 20, reset_at: later },
		},
	});
	assert.deepEqual(
		usage.windows.map((window) => window.label),
		["limit", "limit"],
	);
	assert.deepEqual(
		usage.windows.map((window) => window.resetsAt?.getTime()),
		[soon * 1000, later * 1000],
	);
	const past = parseCodex({ rate_limit: { primary_window: {
		used_percent: 10, reset_at: soon - 7200,
	} } }).windows[0];
	assert.equal(past?.label, "limit");
	assert.equal(past?.resetsAt?.getTime(), (soon - 7200) * 1000);
});

test("Codex uses a neutral label when nothing about the window is known", () => {
	const usage = parseCodex({
		rate_limit: { primary_window: { used_percent: 17 } },
	});
	assert.deepEqual(usage.windows, [{ label: "limit", used: 17, resetsAt: undefined }]);
	assert.deepEqual(parseCodex({}), { windows: [] });
});

test("Grok only exposes weekly unified billing", () => {
	assert.deepEqual(
		parseGrok({
			config: {
				creditUsagePercent: 60,
				currentPeriod: {
					type: "USAGE_PERIOD_TYPE_WEEKLY",
					end: "2030-01-01T00:00:00Z",
				},
			},
		}),
		{
			windows: [
				{
					label: "7d",
					used: 60,
					resetsAt: new Date("2030-01-01T00:00:00Z"),
				},
			],
		},
	);
	assert.deepEqual(
		parseGrok({
			config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } },
		}),
		{ windows: [] },
	);
	assert.deepEqual(
		parseGrok({
			config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
		}).windows,
		[],
	);
});

test("Kimi parses the weekly subscription and five-hour window", () => {
	const usage = parseKimi({
		usage: {
			limit: "100",
			used: "50",
			remaining: "50",
			resetTime: "2030-01-08T00:00:00Z",
		},
		limits: [
			{
				window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
				detail: {
					limit: "100",
					used: "5",
					remaining: "95",
					resetTime: "2030-01-01T05:00:00Z",
				},
			},
		],
	});
	assert.deepEqual(
		usage.windows.map((window) => [window.label, window.used]),
		[
			["7d", 50],
			["5h", 5],
		],
	);
	assert.equal(
		usage.windows[0]?.resetsAt?.toISOString(),
		"2030-01-08T00:00:00.000Z",
	);
	assert.equal(
		usage.windows[1]?.resetsAt?.toISOString(),
		"2030-01-01T05:00:00.000Z",
	);
});

test("Kimi derives usage from remaining when used is missing", () => {
	const usage = parseKimi({
		limits: [
			{
				window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
				detail: { limit: "200", remaining: "150" },
			},
		],
	});
	assert.deepEqual(
		usage.windows.map((window) => [window.label, window.used]),
		[["5h", 25]],
	);
});

test("Kimi skips rows without quota numbers and tolerates empty payloads", () => {
	assert.deepEqual(
		parseKimi({ limits: [{ window: { duration: 300 } }], usage: {} }),
		{ windows: [], incomplete: true },
	);
	assert.deepEqual(parseKimi({}), { windows: [] });
	assert.deepEqual(parseKimi(undefined), { windows: [] });
});

test("Codex uses neutral labels for missing or invalid durations", () => {
	for (const seconds of [undefined, null, 0, -1, "", "bad", NaN, Infinity]) {
		const usage = parseCodex({
			rate_limit: {
				primary_window: {
					used_percent: 0,
					limit_window_seconds: seconds,
					reset_at: "2030-01-01T00:00:00Z",
				},
			},
		});
		assert.equal(usage.windows[0]?.label, "limit", String(seconds));
		assert.equal(usage.windows[0]?.used, 0);
		assert.equal(usage.windows[0]?.resetsAt?.toISOString(), "2030-01-01T00:00:00.000Z");
	}
	assert.equal(parseCodex({ rate_limit: { primary_window: {
		used_percent: 100, limit_window_seconds: "7200",
	} } }).windows[0]?.label, "2h");
});

test("reset timestamps reject overflow while retaining valid absolute and relative dates", (t) => {
	const now = Date.UTC(2030, 0, 1);
	t.mock.timers.enable({ apis: ["Date"], now });
	for (const reset of [1e308, -1e308, NaN, Infinity, "invalid-date"]) {
		assert.equal(parseClaude({ five_hour: {
			utilization: 10, resets_at: reset,
		} }).windows[0]?.resetsAt === undefined, true);
		assert.equal(parseCodex({ rate_limit: { primary_window: {
			used_percent: 10, reset_at: reset,
		} } }).windows[0]?.resetsAt === undefined, true);
	}
	for (const seconds of [1e308, -1e308, Infinity]) {
		assert.equal(parseCodex({ rate_limit: { primary_window: {
			used_percent: 10, reset_after_seconds: seconds,
		} } }).windows[0]?.resetsAt === undefined, true);
	}
	const relative = parseCodex({ rate_limit: { primary_window: {
		used_percent: 10, reset_after_seconds: 3600,
	} } }).windows[0];
	assert.equal(relative?.label, "limit");
	assert.equal(relative?.resetsAt?.getTime(), now + 3_600_000);
	const fallback = parseCodex({ rate_limit: { primary_window: {
		used_percent: 10, reset_at: 1e308, reset_after_seconds: 120,
	} } }).windows[0];
	assert.equal(fallback?.resetsAt?.getTime(), now + 120_000);
	for (const reset of [now / 1000, now, "2030-01-01T00:00:00Z"]) {
		assert.equal(parseClaude({ five_hour: {
			utilization: 0, resets_at: reset,
		} }).windows[0]?.resetsAt?.getTime(), now);
	}
});

test("Grok unknown usage stays unknown and genuine percentage endpoints remain valid", () => {
	for (const used of [undefined, null, "", "bad", NaN, Infinity]) {
		assert.deepEqual(parseGrok({ config: {
			creditUsagePercent: used,
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
		} }).windows, []);
	}
	for (const used of [0, 100, "0", "100"]) {
		assert.equal(parseGrok({ config: {
			creditUsagePercent: used,
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" },
		} }).windows[0]?.used, Number(used));
	}
});

test("Kimi requires valid explicit units and finite positive converted durations", () => {
	for (const window of [
		{ duration: 300 },
		{ duration: 300, timeUnit: "TIME_UNIT_UNKNOWN" },
		{ duration: 0, timeUnit: "TIME_UNIT_SECOND" },
		{ duration: -1, timeUnit: "TIME_UNIT_HOUR" },
		{ duration: 1e308, timeUnit: "TIME_UNIT_WEEK" },
	]) {
		assert.equal(parseKimi({ limits: [{ window, detail: { limit: 100, used: 25 } }] }).windows[0]?.label, "Limit");
	}
	assert.equal(parseKimi({ limits: [{
		window: { duration: 90, timeUnit: "TIME_UNIT_SECOND" },
		detail: { limit: 100, used: 25 },
	}] }).windows[0]?.label, "90s");
});

test("Kimi skips malformed entries and rejects overflowing derived percentages", () => {
	assert.deepEqual(parseKimi({ limits: [null, 1, "bad", [], {
		window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
		detail: { limit: 100, used: 0 },
	}] }).windows.map(({ label, used }) => ({ label, used })), [{ label: "5h", used: 0 }]);
	assert.deepEqual(parseKimi({ usage: { limit: 1e-308, used: 1e308 } }).windows, []);
	assert.deepEqual(parseKimi({ usage: { limit: 1e308, remaining: -1e308 } }).windows, []);
	assert.equal(parseDeepSeek({ balance_infos: [{ currency: "USD", total_balance: "0" }] }).balance?.amounts[0]?.amount, 0);
});

test("provider parsers tolerate malformed JSON-shaped roots without inventing quota", () => {
	for (const parse of [parseClaude, parseCodex, parseDeepSeek, parseGrok, parseKimi]) {
		for (const body of [undefined, null, false, 1, "bad", [], { limits: [null] }]) {
			assert.deepEqual(parse(body).windows, []);
		}
	}
});
