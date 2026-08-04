import assert from "node:assert/strict";
import test from "node:test";
import {
	formatCompact,
	formatDetails,
	remainingColor,
	remainingPercent,
	renderUsage,
	usageBar,
} from "../src/ui.js";
import type { Theme, UiContext, UsageWindow } from "../src/types.js";

test("usageBar renders remaining quota with an eight-cell default", () => {
	assert.equal(usageBar(-10), "────────");
	assert.equal(usageBar(0), "────────");
	assert.equal(usageBar(25), "━━──────");
	assert.equal(usageBar(50, 4), "━━──");
	assert.equal(usageBar(100), "━━━━━━━━");
	assert.equal(usageBar(150), "━━━━━━━━");
});

test("remaining quota and color thresholds follow the configured semantics", () => {
	const window = (used: number): UsageWindow => ({ label: "7d", used });
	assert.equal(remainingPercent(window(-10)), 100);
	assert.equal(remainingPercent(window(31)), 69);
	assert.equal(remainingPercent(window(150)), 0);
	assert.equal(remainingColor(100), "success");
	assert.equal(remainingColor(30), "success");
	assert.equal(remainingColor(29), "warning");
	assert.equal(remainingColor(10), "warning");
	assert.equal(remainingColor(9), "error");
});

test("formatCompact renders explicit window names, bars, and remaining quota", () => {
	assert.equal(
		formatCompact([
			{
				provider: "kimi",
				label: "work",
				windows: [
					{ label: "7d", used: 50 },
					{ label: "5h", used: 5 },
				],
			},
			{
				provider: "codex",
				label: "plus",
				windows: [{ label: "7d", used: 31 }],
			},
		]),
		[
			"Kimi work  7d ━━━━──── left 50%  5h ━━━━━━━━ left 95%",
			"Codex plus  7d ━━━━━━── left 69%",
		].join("\n"),
	);
});

function createContext() {
	let widget: unknown;
	const colors: string[] = [];
	const theme: Theme = {
		fg: (color, text) => {
			colors.push(color);
			return text;
		},
	};
	const ctx = {
		mode: "interactive",
		ui: {
			theme,
			setStatus() {},
			setWidget: (_id, content) => {
				widget = content;
			},
			notify() {},
			select: async () => undefined,
			input: async () => undefined,
		},
	} satisfies UiContext;
	return {
		ctx,
		theme,
		colors,
		render(width = 120): string[] {
			const factory = widget as (
				tui: unknown,
				theme: Theme,
			) => { render(width: number): string[] };
			return factory(undefined, theme).render(width);
		},
	};
}

test("renderUsage keeps seven-day before five-hour and colors remaining quota", () => {
	const { ctx, colors, render } = createContext();
	renderUsage(
		ctx,
		[
			{
				provider: "kimi",
				label: "account",
				windows: [
					{ label: "7d", used: 50 },
					{ label: "5h", used: 5 },
				],
			},
		],
		4,
	);
	assert.equal(
		render()[0],
		"Kimi │ account │ 7d ━━━━──── left 50% │ 5h ━━━━━━━━ left 95%\u001b[0m",
	);
	assert.equal(colors.filter((color) => color === "success").length, 4);
});

test("renderUsage uses yellow below 30% left and red below 10% left", () => {
	const { ctx, colors, render } = createContext();
	renderUsage(
		ctx,
		[
			{
				provider: "codex",
				label: "work",
				windows: [
					{ label: "7d", used: 71 },
					{ label: "5h", used: 91 },
				],
			},
		],
		4,
	);
	render();
	assert.equal(colors.filter((color) => color === "warning").length, 2);
	assert.equal(colors.filter((color) => color === "error").length, 2);
});

test("renderUsage packs two cards into one row when width allows", () => {
	const { ctx, render } = createContext();
	renderUsage(
		ctx,
		[
			{
				provider: "claude",
				label: "a",
				windows: [{ label: "7d", used: 50 }],
			},
			{
				provider: "codex",
				label: "long",
				windows: [{ label: "7d", used: 31 }],
			},
		],
		4,
	);
	const lines = render(120);
	assert.equal(lines.length, 1);
	assert.match(lines[0] ?? "", /Claude/);
	assert.match(lines[0] ?? "", /Codex/);
	assert.match(lines[0] ?? "", /7d ━━━━──── left 50%/);
	assert.match(lines[0] ?? "", /7d ━━━━━━── left 69%/);
});

test("renderUsage switches between three, two, and one account columns", () => {
	const { ctx, render } = createContext();
	renderUsage(
		ctx,
		["alpha", "beta", "gamma"].map((label, index) => ({
			provider: "codex" as const,
			label,
			windows: [{ label: "7d", used: 20 + index * 10 }],
		})),
		4,
	);
	const wide = render(180);
	assert.equal(wide.length, 2);
	assert.match(wide[0] ?? "", /Codex quota · 3 accounts/);
	assert.match(wide[1] ?? "", /alpha/);
	assert.match(wide[1] ?? "", /beta/);
	assert.match(wide[1] ?? "", /gamma/);

	const medium = render(70);
	assert.equal(medium.length, 3);
	assert.match(medium[1] ?? "", /gamma.*beta/);
	assert.match(medium[2] ?? "", /alpha/);

	const narrow = render(40);
	assert.equal(narrow.length, 4);
});

test("renderUsage limits rows and prioritizes errors then highest usage", () => {
	const { ctx, render } = createContext();
	renderUsage(
		ctx,
		[
			{
				provider: "claude",
				label: "low",
				windows: [{ label: "7d", used: 10 }],
			},
			{
				provider: "codex",
				label: "high",
				windows: [{ label: "7d", used: 90 }],
			},
			{ provider: "grok", label: "broken", windows: [], error: "HTTP 401" },
		],
		2,
	);
	const lines = render();
	assert.equal(lines.length, 2);
	assert.match(lines[0] ?? "", /broken/);
	assert.match(lines[0] ?? "", /high/);
	assert.equal(
		lines[1],
		"… 1 more account · /cliproxy-usage for details\u001b[0m",
	);
});

test("formatCompact handles errors and missing windows", () => {
	assert.equal(
		formatCompact([
			{ provider: "grok", label: "x", windows: [], error: "HTTP 401" },
			{ provider: "codex", label: "empty", windows: [] },
		]),
		"Grok x: ! HTTP 401\nCodex empty  –",
	);
});

test("formatDetails handles empty, success, errors, and missing data", () => {
	assert.equal(formatDetails([]), "No enabled CLIProxyAPI accounts found.");
	assert.equal(
		formatDetails([
			{
				provider: "kimi",
				label: "me",
				windows: [
					{ label: "7d", used: 50 },
					{ label: "5h", used: 5 },
				],
			},
			{ provider: "grok", label: "bad", windows: [], error: "HTTP 403" },
			{ provider: "codex", label: "empty", windows: [] },
		]),
		[
			"kimi/me: 7d ━━━━──── left 50% · 5h ━━━━━━━━ left 95%",
			"grok/bad: HTTP 403",
			"codex/empty: No usage window",
		].join("\n"),
	);
});
