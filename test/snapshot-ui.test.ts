import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatBalance, formatSnapshotDetails, formatUsageAge,
	renderUsage, snapshotStatusText,
} from "../src/ui.js";
import type { AccountUsageSnapshot, Theme, UiContext, UsageSnapshot } from "../src/types.js";

const now = Date.UTC(2030, 0, 1);
function account(overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
	return {
		provider: "codex", label: "work", windows: [{ label: "7d", used: 100 }],
		result: "valid", queried: true, cached: false, stale: false,
		lastValidAt: now - 120_000, attemptedAt: now - 130_000, ...overrides,
	};
}
function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return {
		provider: "codex", state: "ready", configuration: { status: "ready" },
		refreshing: false, stale: false, partial: false, accounts: [], generatedAt: now,
		...overrides,
	};
}
function widget(value: UsageSnapshot, width = 160): string[] | undefined {
	let content: unknown;
	const theme: Theme = { fg: (_color, text) => text };
	const ctx: UiContext = { mode: "tui", ui: {
		theme, setWidget: (_id, next) => { content = next; }, setStatus() {}, notify() {},
		select: async () => undefined, input: async () => undefined,
	} };
	renderUsage(ctx, value, 4);
	return typeof content === "function" ? content(undefined, theme).render(width) : content as undefined;
}

test("shared short status covers every snapshot state and hides only unsupported/disabled widgets", () => {
	const cases: [UsageSnapshot["state"], string][] = [
		["unsupported", "unsupported"], ["disabled", "disabled"], ["setup-required", "setup required"],
		["idle", "not refreshed"], ["loading", "loading"], ["ready", ""],
		["empty", "no accounts"], ["unknown", "unknown"], ["error", "error"],
	];
	for (const [state, expected] of cases) {
		const value = snapshot({ state });
		assert.equal(snapshotStatusText(value), expected, state);
		const lines = widget(value);
		if (state === "unsupported" || state === "disabled") assert.equal(lines, undefined);
		else if (expected) assert.equal(lines?.[0], expected);
		assert.match(formatSnapshotDetails(value), new RegExp(`Usage state: ${state}`));
	}
	assert.deepEqual(widget(snapshot({ accounts: [account()] }))?.length, 1);
});

test("refreshing retains stale/partial/error status and cached quota numbers", () => {
	const item = account({ result: "error", error: "HTTP 503", cached: true, stale: true });
	const value = snapshot({ state: "error", refreshing: true, stale: true, accounts: [item] });
	const status = snapshotStatusText(value);
	for (const word of ["refreshing", "stale", "error"]) assert.ok(status.includes(word));
	const lines = widget(value)!;
	assert.equal(lines[0], status);
	assert.match(lines.join("\n"), /left 0%.*cached.*stale.*HTTP 503/);
	assert.doesNotMatch(lines.join("\n"), /age|ago/);
	assert.match(formatSnapshotDetails(value), /left 0%/);
	assert.match(formatSnapshotDetails(value), /cached.*stale.*error: HTTP 503/);
	const mixed = snapshot({ state: "error", partial: true, accounts: [
		account({ result: "unknown", windows: [] }), item,
	] });
	assert.match(snapshotStatusText(mixed), /error/);
	assert.match(snapshotStatusText(mixed), /partial/);
});

test("cached balances including zero/negative remain visible with error annotations", () => {
	for (const amount of [0, -2, 42.5]) {
		const balance = { available: amount > 0, amounts: [{ currency: "USD", amount }] } as const;
		const value = snapshot({ state: "error", stale: true, accounts: [account({
			provider: "deepseek", windows: [], balance, result: "error", error: "offline", cached: true, stale: true,
		})] });
		assert.match(widget(value)!.join("\n"), new RegExp(`\\$${amount.toFixed(2).replace(".", "\\.")}.*cached.*offline`));
		assert.ok(formatSnapshotDetails(value).includes(formatBalance(balance)));
	}
});

test("unknown is explicit, without historical numbers, and actual zeros stay valid", () => {
	const value = snapshot({ state: "unknown", accounts: [account({ result: "unknown", windows: [] })] });
	for (const text of [widget(value)!.join("\n"), formatSnapshotDetails(value)]) {
		assert.match(text, /unknown/);
		assert.doesNotMatch(text, /left|100%|\$0/);
	}
	assert.match(widget(snapshot({ accounts: [account()] }))!.join("\n"), /left 0%/);
});

test("full formatter distinguishes complete success, round attempt, valid age and actual query attempt", () => {
	const value = snapshot({
		lastCompleteSuccessAt: now - 300_000, lastAttemptAt: now - 30_000,
		state: "error", error: "Discovery failed", stale: true,
		accounts: [account({ queried: false, result: "error", error: "Unavailable", cached: true, stale: true })],
	});
	const text = formatSnapshotDetails(value);
	assert.ok(text.includes(`Last refresh: ${new Date(now - 300_000).toISOString()}`));
	assert.ok(text.includes(`Last attempt: ${new Date(now - 30_000).toISOString()}`));
	assert.match(text, /data age: 2m/);
	assert.ok(text.includes(`Last query attempt: ${new Date(now - 130_000).toISOString()}`));
	assert.match(text, /not queried/);
	assert.match(text, /Discovery failed/);
	assert.doesNotMatch(text, /request failed|just failed/);
	const unqueried = formatSnapshotDetails(snapshot({ accounts: [account({
		queried: false, attemptedAt: undefined, lastValidAt: undefined, result: "error", windows: [], error: "Missing ID",
	})] }));
	assert.match(unqueried, /Last refresh: never/);
	assert.match(unqueried, /Last attempt: never/);
	assert.match(unqueried, /not queried/);
	assert.doesNotMatch(unqueried, /Last query attempt:/);
});

test("formatters tolerate missing, future and out-of-range timestamps", () => {
	assert.equal(formatUsageAge(undefined, now), "unknown");
	assert.equal(formatUsageAge(NaN, now), "unknown");
	assert.equal(formatUsageAge(Infinity, now), "unknown");
	assert.equal(formatUsageAge(1e20, now), "unknown");
	assert.equal(formatUsageAge(now + 1000, now), "0m");
	assert.equal(formatUsageAge(now - 86_400_000, now), "1d");
	const text = formatSnapshotDetails(snapshot({ lastAttemptAt: NaN, lastCompleteSuccessAt: 1e20 }));
	assert.doesNotMatch(text, /Invalid Date|NaN/);
});

test("setup uses only snapshot messages; widgets remain short and width bounded", () => {
	const value = snapshot({ state: "setup-required", configuration: {
		status: "setup-required", reason: "rejected", message: "Use settings to update Management access",
	}, error: "Access rejected" });
	assert.match(formatSnapshotDetails(value), /Use settings to update Management access/);
	assert.match(formatSnapshotDetails(value), /Access rejected/);
	assert.doesNotMatch(widget(value)!.join("\n"), /Management|missing|rejected/);
	for (const width of [0, 1, 2, 8, 30]) {
		assert.ok(widget(snapshot({ state: "error", accounts: [account({ label: "中文账户长名称", error: "offline", result: "error" })] }), width)!
			.every((line) => visibleWidth(line) <= width));
	}
});

test("ready background refresh and partial unknown preserve the independent short status", () => {
	for (const [value, expected] of [
		[snapshot({ refreshing: true, accounts: [account()] }), "refreshing"],
		[snapshot({ partial: true, accounts: [account(), account({ result: "unknown", windows: [] })] }), "partial"],
		[snapshot({ stale: true, accounts: [account({ stale: true })] }), "stale"],
	] as const) {
		assert.equal(snapshotStatusText(value), expected);
		assert.equal(widget(value)?.[0], expected);
		assert.ok(formatSnapshotDetails(value).includes(`Usage state: ${value.state}`));
		assert.ok(formatSnapshotDetails(value).includes(`Status: ${expected}`));
	}
	for (const used of [0, 100]) {
		const value = snapshot({ accounts: [account({ windows: [{ label: "7d", used }] })] });
		assert.ok(widget(value)!.join("\n").includes(`left ${100 - used}%`));
		assert.ok(formatSnapshotDetails(value).includes(`left ${100 - used}%`));
	}
});
