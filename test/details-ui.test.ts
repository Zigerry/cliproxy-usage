import assert from "node:assert/strict";
import test from "node:test";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { UsageDetailsComponent } from "../src/details-ui.js";
import { formatSnapshotDetails, snapshotStatusText } from "../src/ui.js";
import type { AccountUsageSnapshot, UsageSnapshot } from "../src/types.js";

const now = Date.UTC(2030, 0, 1);
function account(overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
	return { provider: "codex", label: "work@example.com", windows: [{
		label: "7d", used: 32, resetsAt: new Date(now + 2 * 60 * 60_000),
	}], result: "valid", queried: true, cached: false, stale: false, lastValidAt: now - 120_000,
	attemptedAt: now - 130_000, ...overrides };
}
function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
	return { provider: "codex", state: "ready", configuration: { status: "ready" },
		refreshing: false, stale: false, partial: false, accounts: [], generatedAt: now, ...overrides };
}
function createComponent(value: UsageSnapshot, rows = 24) {
	let refreshes = 0, closes = 0, disposals = 0, renderRequests = 0, reads = 0;
	const tui = { terminal: { rows }, requestRender: () => { renderRequests++; } } as unknown as TUI;
	const theme = { fg: (_color: string, text: string) => text } as unknown as PiTheme;
	const component = new UsageDetailsComponent(tui, theme, {
		getSnapshot: () => { reads++; return value; },
		onRefresh: () => { refreshes++; }, onClose: () => { closes++; }, onDispose: () => { disposals++; },
	});
	return { component, stats: () => ({ refreshes, closes, disposals, renderRequests, reads }) };
}

test("details renders unchanged quota bars, reset time, metadata and bounded lines", () => {
	const { component } = createComponent(snapshot({ accounts: [account()] }));
	try {
		const lines = component.render(72);
		assert.match(lines[0] ?? "", /CLIProxyAPI Usage/);
		assert.match(lines.join("\n"), /Codex · work@example.com/);
		assert.match(lines.join("\n"), /7d ━━━━━─── left 68%/);
		assert.match(lines.join("\n"), /resets in 2h/);
		assert.match(lines.join("\n"), /data age: 2m/);
		assert.match(lines.join("\n"), /Last query attempt: 2029-12-31T23:57:50.000Z/);
		assert.match(lines.at(-2) ?? "", /r refresh · Enter\/Esc close/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 72));
	} finally { component.dispose(); }
});

test("details uses shared snapshot status, preserving cached errors while refreshing", () => {
	const value = snapshot({ state: "error", refreshing: true, stale: true, error: "HTTP 503", accounts: [
		account({ result: "error", error: "HTTP 503", cached: true, stale: true }),
	] });
	const { component } = createComponent(value);
	try {
		const text = component.render(100).join("\n");
		assert.ok(text.includes(snapshotStatusText(value)));
		assert.ok(formatSnapshotDetails(value).includes(snapshotStatusText(value)));
		assert.match(text, /left 68%/);
		assert.match(text, /cached.*stale.*error: HTTP 503/);
		assert.match(text, /HTTP 503/);
	} finally { component.dispose(); }
});

test("details distinguishes unknown, empty, loading, setup and real zero balance", () => {
	for (const state of ["unknown", "empty", "loading", "setup-required", "disabled", "unsupported"] as const) {
		const value = snapshot({ state, accounts: state === "unknown" ? [account({ result: "unknown", windows: [] })] : [] });
		const { component } = createComponent(value);
		try {
			const text = component.render(80).join("\n");
			assert.ok(text.includes(snapshotStatusText(value)), state);
			assert.doesNotMatch(text, /left|100%|\$0/);
		} finally { component.dispose(); }
	}
	const { component } = createComponent(snapshot({ accounts: [account({ windows: [], balance: {
		available: false, amounts: [{ currency: "USD", amount: 0 }],
	} })] }));
	try { assert.match(component.render(80).join("\n"), /\$0.00/); }
	finally { component.dispose(); }
});

test("details pins status and a separate error row outside scrolling body", () => {
	const value = snapshot({ state: "error", refreshing: true, stale: true, error: "Discovery failed", accounts:
		Array.from({ length: 12 }, (_, index) => account({ label: `account-${index}`, cached: true, stale: true })),
	});
	const { component } = createComponent(value, 10);
	try {
		const initial = component.render(80);
		assert.equal(initial.length, 10);
		assert.ok(initial[1]?.includes(snapshotStatusText(value)));
		assert.match(initial[2] ?? "", /Discovery failed/);
		component.handleInput("\x1b[6~");
		const scrolled = component.render(80);
		assert.notDeepEqual(scrolled, initial);
		assert.equal(scrolled[1], initial[1]);
		assert.equal(scrolled[2], initial[2]);
		assert.match(scrolled.at(-2) ?? "", /↑↓ scroll/);
	} finally { component.dispose(); }
});

test("details bounds height and width on very short terminals without permanently hiding status", () => {
	for (const rows of [0, 1, 2, 3, 4, 5, 6, 8]) {
		for (const width of [0, 1, 2, 8, 24, 80]) {
			const value = snapshot({ state: "error", error: "HTTP 503", accounts: [account()] });
			const { component } = createComponent(value, rows);
			try {
				const lines = component.render(width);
				assert.ok(lines.length <= rows, `${rows} rows / ${width} columns: ${lines.length}`);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				if (rows >= 1 && width >= 24) assert.match(lines.join("\n"), /error/);
				if (rows >= 2 && width >= 24) assert.match(lines.join("\n"), /Esc close/);
			} finally { component.dispose(); }
		}
	}
});

test("details handles refresh, arrow/page scrolling, close, and idempotent disposal", () => {
	const { component, stats } = createComponent(snapshot({ accounts:
		Array.from({ length: 8 }, (_, index) => account({ label: `account-${index}` })),
	}), 9);
	const initial = component.render(80);
	component.handleInput("\x1b[B");
	assert.notDeepEqual(component.render(80), initial);
	component.handleInput("\x1b[A");
	assert.deepEqual(component.render(80), initial);
	component.handleInput("\x1b[6~");
	assert.notDeepEqual(component.render(80), initial);
	component.handleInput("\x1b[5~");
	assert.deepEqual(component.render(80), initial);
	component.handleInput("r");
	assert.deepEqual(component.render(80), initial);
	component.handleInput("\r");
	component.handleInput("\x1b");
	component.dispose();
	component.dispose();
	assert.equal(stats().refreshes, 1);
	assert.equal(stats().closes, 2);
	assert.equal(stats().disposals, 1);
	assert.ok(stats().renderRequests >= 5);
	assert.ok(stats().reads >= 5);
});

test("details local 30s redraw is disposed and never refreshes providers", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const { component, stats } = createComponent(snapshot());
	try {
		t.mock.timers.tick(29_999);
		assert.equal(stats().renderRequests, 0);
		t.mock.timers.tick(1);
		assert.equal(stats().renderRequests, 1);
		assert.equal(stats().refreshes, 0);
		assert.equal(stats().reads, 0);
		component.dispose();
		t.mock.timers.tick(60_000);
		assert.equal(stats().renderRequests, 1);
	} finally { component.dispose(); t.mock.timers.reset(); }
});

test("a single terminal row retains the failure state and an exit hint", () => {
	const { component } = createComponent(snapshot({ state: "error", refreshing: true, stale: true,
		error: "offline", accounts: [account({ cached: true, stale: true })],
	}), 1);
	try {
		const lines = component.render(24);
		assert.equal(lines.length, 1);
		assert.match(lines[0] ?? "", /error/);
		assert.match(lines[0] ?? "", /Esc/);
		assert.ok(visibleWidth(lines[0] ?? "") <= 24);
	} finally { component.dispose(); }
});

test("details preserves zero usage/remaining and performs no reads or actions after disposal", () => {
	for (const used of [0, 100]) {
		const { component, stats } = createComponent(snapshot({ accounts: [account({ windows: [{ label: "7d", used }] })] }));
		assert.ok(component.render(80).join("\n").includes(`left ${100 - used}%`));
		component.dispose();
		const disposed = stats();
		component.handleInput("r");
		component.handleInput("\r");
		assert.deepEqual(component.render(80), []);
		assert.deepEqual(stats(), disposed);
	}
});
