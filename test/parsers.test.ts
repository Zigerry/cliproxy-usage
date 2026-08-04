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

test("Codex infers window length from reset distance when duration is absent", () => {
	const soon = Math.floor((Date.now() + 2 * 3_600_000) / 1000);
	const later = Math.floor((Date.now() + 4 * 86_400_000) / 1000);
	const usage = parseCodex({
		rate_limit: {
			primary_window: { used_percent: 10, reset_at: soon },
			secondary_window: { used_percent: 20, reset_at: later },
		},
	});
	assert.deepEqual(
		usage.windows.map((window) => window.label),
		["7d", "5h"],
	);
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
	assert.equal(
		parseGrok({
			config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
		}).windows[0]?.used,
		0,
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
		{ windows: [] },
	);
	assert.deepEqual(parseKimi({}), { windows: [] });
	assert.deepEqual(parseKimi(undefined), { windows: [] });
});
