import assert from "node:assert/strict";
import test from "node:test";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { UsageDetailsComponent } from "../src/details-ui.js";
import type { AccountUsage } from "../src/types.js";

function createComponent(
	items: AccountUsage[],
	options: {
		rows?: number;
		fetched?: boolean;
		refreshing?: boolean;
		error?: string;
	} = {},
) {
	let refreshes = 0;
	let closes = 0;
	let disposals = 0;
	let renderRequests = 0;
	const tui = {
		terminal: { rows: options.rows ?? 24 },
		requestRender: () => {
			renderRequests++;
		},
	} as unknown as TUI;
	const theme = {
		fg: (_color: string, text: string) => text,
	} as unknown as PiTheme;
	const component = new UsageDetailsComponent(tui, theme, {
		getItems: () => items,
		hasFetched: () => options.fetched ?? true,
		isRefreshing: () => options.refreshing ?? false,
		getError: () => options.error,
		onRefresh: () => {
			refreshes++;
		},
		onClose: () => {
			closes++;
		},
		onDispose: () => {
			disposals++;
		},
	});
	return {
		component,
		stats: () => ({ refreshes, closes, disposals, renderRequests }),
	};
}

test("details TUI renders account windows, reset time, and bounded lines", () => {
	const now = Date.now();
	const { component } = createComponent([
		{
			provider: "codex",
			label: "work@example.com",
			windows: [
				{
					label: "7d",
					used: 32,
					resetsAt: new Date(now + 2 * 60 * 60_000),
				},
			],
		},
	]);
	try {
		const lines = component.render(54);
		assert.match(lines[0] ?? "", /CLIProxyAPI Usage/);
		assert.ok(lines.some((line) => line.includes("Codex · work@example.com")));
		assert.ok(lines.some((line) => /7d ━━━━━─── left 68%/.test(line)));
		assert.ok(lines.some((line) => /resets in 2h/.test(line)));
		assert.match(lines.at(-2) ?? "", /r refresh · Enter\/Esc close/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 54));
	} finally {
		component.dispose();
	}
});

test("details TUI shows refresh state and cached-data errors", () => {
	const { component } = createComponent(
		[
			{
				provider: "kimi",
				label: "team@example.com",
				windows: [{ label: "7d", used: 25 }],
			},
		],
		{ error: "HTTP 503" },
	);
	try {
		assert.ok(
			component
				.render(72)
				.some((line) =>
					line.includes("Refresh failed: HTTP 503 · showing cached data"),
				),
		);
	} finally {
		component.dispose();
	}

	const refreshing = createComponent([], {
		fetched: false,
		refreshing: true,
	});
	try {
		assert.ok(
			refreshing.component
				.render(50)
				.some((line) => line.includes("Refreshing…")),
		);
	} finally {
		refreshing.component.dispose();
	}
});

test("details TUI handles refresh, scrolling, close, and disposal", () => {
	const items = ["alpha", "beta", "gamma"].map((label) => ({
		provider: "codex" as const,
		label,
		windows: [{ label: "7d", used: 50 }],
	}));
	const { component, stats } = createComponent(items, { rows: 7 });
	const initial = component.render(50);
	assert.equal(initial.length, 7);
	assert.match(initial[0] ?? "", /CLIProxyAPI Usage/);
	assert.match(initial.at(-2) ?? "", /↑↓ scroll/);
	assert.match(initial.at(-1) ?? "", /╰─+╯/);

	component.handleInput("r");
	component.handleInput("\x1b[6~");
	const scrolled = component.render(50);
	assert.notDeepEqual(scrolled, initial);
	component.handleInput("\r");
	component.handleInput("\x1b");
	component.dispose();

	assert.equal(stats().refreshes, 1);
	assert.equal(stats().closes, 2);
	assert.equal(stats().disposals, 1);
	assert.ok(stats().renderRequests >= 2);
});
