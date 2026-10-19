import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { UsageDetailsComponent } from "../src/details-ui.js";
import { applyProviderRead, deriveUsageSnapshot } from "../src/state.js";
import { layoutBalance, layoutQuotaWindow, renderUsage } from "../src/ui.js";
import type { AccountUsageSnapshot, Theme, UiContext, UsageSnapshot } from "../src/types.js";

const now = Date.UTC(2030, 0, 1);
const theme: Theme = { fg: (_color, text) => `\x1b[36m${text}\x1b[0m` };
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
function account(overrides: Partial<AccountUsageSnapshot> = {}): AccountUsageSnapshot {
	return { provider: "codex", label: "共同前缀👩‍💻é-very-long-account-one@example.invalid", queried: true,
		result: "error", cached: true, stale: true, error: "HTTP 503 offline", lastValidAt: now - 120_000,
		windows: [{ label: "7d", used: 0, resetsAt: new Date(now + 120_000) }, { label: "5h", used: 100 }], ...overrides };
}
function snapshot(accounts: readonly AccountUsageSnapshot[]): UsageSnapshot {
	return { state: "error", configuration: { status: "ready" }, refreshing: true, stale: true,
		partial: false, generatedAt: now, accounts };
}
function widget(value: UsageSnapshot, width: number): string[] {
	let content: unknown;
	const ctx: UiContext = { mode: "tui", ui: { theme, setWidget: (_id, next) => { content = next; },
		setStatus() {}, notify() {}, select: async () => undefined, input: async () => undefined } };
	renderUsage(ctx, value, 4);
	return (content as (tui: unknown, theme: Theme) => { render(width: number): string[] })(undefined, theme).render(width);
}
function details(value: UsageSnapshot, rows = 100) {
	const terminal = { rows };
	const tui = { terminal, requestRender() {} } as unknown as TUI;
	const component = new UsageDetailsComponent(tui, theme as PiTheme, { getSnapshot: () => value, onRefresh() {}, onClose() {} });
	return { component, tui, terminal };
}
function bounded(lines: string[], width: number) {
	assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}: ${plain(lines.join("\n"))}`);
}
function quotaFields(lines: string[]) {
	const text = plain(lines.join("\n"));
	assert.match(text, /7d [^\n]*left 100%/);
	assert.match(text, /5h [^\n]*left 0%/);
	assert.doesNotMatch(text, /left \d+(?![\d%])/);
	for (const annotation of ["cached", "stale", "error", "HTTP 503"]) assert.ok(text.includes(annotation), annotation);
}

for (const width of [30, 40, 80, 120]) {
	test(`quota fields and retained failure annotations survive ${width} columns in both views`, () => {
		const value = snapshot([account()]);
		const lines = widget(value, width);
		bounded(lines, width); quotaFields(lines);
		const { component } = details(value);
		try { const rendered = component.render(width); bounded(rendered, width); quotaFields(rendered); }
		finally { component.dispose(); }
	});
}

test("multiline accounts remain grouped with distinct same-prefix identities", () => {
	const value = snapshot([account(), account({ label: "共同前缀👩‍💻é-very-long-account-two@example.invalid" })]);
	for (const width of [30, 40]) {
		for (const view of ["widget", "details"]) {
			const { component } = details(value);
			try {
				const lines = (view === "widget" ? widget(value, width) : component.render(width)).map(plain);
				const first = lines.findIndex((line) => /#1\b/.test(line));
				const second = lines.findIndex((line) => /#2\b/.test(line));
				assert.ok(first >= 0 && second > first, `${view} ${width}: ${lines.join("\n")}`);
				for (const group of [lines.slice(first, second), lines.slice(second)]) quotaFields(group);
			} finally { component.dispose(); }
		}
	}
});

test("balance fields retain signs and disambiguate identical symbols, or explicitly omit the whole field", () => {
	const value = snapshot([account({ provider: "deepseek", windows: [], balance: { available: false, amounts: [
		{ currency: "USD", amount: 0 }, { currency: "EUR", amount: -1234.56 },
		{ currency: "CNY", amount: 12.34 }, { currency: "JPY", amount: 56.78 },
		{ currency: "LONG-CURRENCY-IDENTIFIER", amount: 987654321.12 },
	] } })]);
	for (const width of [30, 40, 80, 120]) {
		const { component } = details(value);
		try {
			for (const lines of [widget(value, width), component.render(width)]) {
				bounded(lines, width);
				const text = plain(lines.join("\n"));
				for (const field of ["$0.00", "€-1234.56", "¥12.34 CNY", "¥56.78 JPY"]) assert.ok(text.includes(field), text);
				assert.ok(text.includes("987654321.12 LONG-CURRENCY-IDENTIFIER") || text.includes("balance omitted"), text);
				if (!text.includes("987654321.12 LONG-CURRENCY-IDENTIFIER")) assert.doesNotMatch(text, /987/);
			}
		} finally { component.dispose(); }
	}
});

test("widths 0..15 never expose partial numbers, duration labels or currency fields", () => {
	for (const label of ["中文账户", "👩‍💻é", "x".repeat(100)]) {
		const value = snapshot([account({ label, windows: [{ label: "7d", used: 0 }, { label: "very-long-window-label", used: 100 }] }),
			account({ provider: "deepseek", label, windows: [], balance: { available: false, amounts: [{ currency: "AUD", amount: -123.45 }] } })]);
		for (let width = 0; width <= 15; width++) {
			const { component } = details(value);
			try {
				for (const lines of [widget(value, width), component.render(width)]) {
					bounded(lines, width);
					const text = plain(lines.join("\n"));
					for (const line of lines.map(plain)) {
						if (line.includes("left")) assert.match(line, /7d [^\n]*left 100%/);
						if (line.includes("123")) assert.ok(line.includes("-123.45 AUD"), line);
					}
					if (width > 3) assert.match(text, /omitted|…/);
					assert.doesNotMatch(text, /very-long-w/);
				}
			} finally { component.dispose(); }
		}
	}
});

test("details stays bounded after scrolling and resizing with D eligibility metadata and pinned errors", () => {
	const value = { ...snapshot(Array.from({ length: 10 }, (_, i) => account({ label: `账户👩‍💻é-${i}` }))),
		eligibility: { automaticAllowedAt: now + 60_000, manualAllowedAt: now + 60_000, nextAutomaticCheckAt: now + 120_000 } };
	const { component, terminal } = details(value, 12);
	try {
		assert.match(plain(component.render(120).join("\n")), /Earliest automatic request:/);
		for (const width of [120, 30, 80, 40, 1, 15, 0, 40]) {
			for (const rows of [12, 6, 2, 1, 0, 18]) {
				terminal.rows = rows;
				component.handleInput("\x1b[6~");
				const lines = component.render(width);
				bounded(lines, width); assert.ok(lines.length <= rows);
				if (width >= 30 && rows >= 12) {
					assert.match(plain(lines.slice(0, 4).join("\n")), /error/);
					assert.match(plain(lines.join("\n")), /Esc close/);
				}
			}
		}
	} finally { component.dispose(); }
});

test("error-only widget data respects its budget at widths 1..5", () => {
	const value = snapshot([account({ windows: [], cached: false, stale: false, error: undefined })]);
	for (let width = 1; width <= 5; width++) {
		const lines = widget(value, width);
		bounded(lines, width);
		assert.ok(lines.some((line) => plain(line).includes("…")), plain(lines.join("\n")));
	}
});

test("empty and sanitized-away labels still have distinct per-account headers", () => {
	const record = applyProviderRead(undefined, { provider: "codex", discovery: "success", items: ["", "\x1b[31m\x1b[0m"].map((label, i) => ({
		provider: "codex", accountId: `opaque-secret-id-${i}`, label, queried: true, windows: [{ label: "7d", used: i * 100 }],
	})) }, { attemptedAt: now, completedAt: now });
	const sanitized = deriveUsageSnapshot({ provider: "codex", enabled: true, configuration: { status: "ready" }, record,
		refreshing: false, now, maxAgeMs: 60_000 });
	for (const value of [sanitized, { ...sanitized, accounts: [...sanitized.accounts,
		account({ provider: "grok", label: "", windows: [], result: "unknown" })] }]) {
		const { component } = details(value);
		try {
			for (const width of [30, 40]) for (const lines of [widget(value, width), component.render(width)]) {
				bounded(lines, width);
				const text = plain(lines.join("\n"));
				assert.match(text, /\S+ #1\b/); assert.match(text, /\S+ #2\b/);
				assert.doesNotMatch(text, /opaque-secret/);
			}
		} finally { component.dispose(); }
	}
});

test("pure field layouts return complete atomic fields or explicit omission, including long window labels", () => {
	for (const width of [...Array.from({ length: 16 }, (_, i) => i), 30, 40, 80, 120]) {
		for (const label of ["7d", "中文👋é-long-window-label-that-must-not-be-shortened"]) {
			const lines = layoutQuotaWindow({ label, used: 0 }, width, theme);
			bounded(lines, width);
			const text = plain(lines.join("\n"));
			if (text.includes("left")) assert.ok(text.includes(label) && text.includes("left 100%"), text);
			else if (width) { assert.match(text, /quota omitted|…/); assert.doesNotMatch(text, /100|中文/); }
			else assert.deepEqual(lines, []);
		}
		const amount = "-123456789.12 AUD";
		const lines = layoutBalance({ available: false, amounts: [{ currency: "AUD", amount: -123456789.12 }] }, width, theme);
		bounded(lines, width);
		const text = plain(lines.join("\n"));
		if (text.includes("123")) assert.equal(text, amount);
		else if (width) { assert.match(text, /balance omitted|…/); assert.doesNotMatch(text, /\d/); }
		else assert.deepEqual(lines, []);
	}
});

test("sanitized snapshot boundary keeps remote terminal controls out of both layouts", () => {
	const record = applyProviderRead(undefined, { provider: "codex", discovery: "success", items: [{ provider: "codex",
		accountId: "a", queried: true, label: "中文\x1b]52;c;ATTACK\x07👋é", windows: [{ label: "7d\x1b[2J", used: 0 }],
	}] }, { attemptedAt: now, completedAt: now });
	const value = deriveUsageSnapshot({ provider: "codex", enabled: true, configuration: { status: "ready" }, record,
		refreshing: false, now, maxAgeMs: 60_000 });
	const { component } = details(value);
	try {
		for (const width of [30, 40, 80, 120]) for (const lines of [widget(value, width), component.render(width)]) {
			bounded(lines, width); const text = plain(lines.join("\n"));
			assert.doesNotMatch(text, /ATTACK|\x1b|\x07/); assert.match(text, /left 100%/);
		}
	} finally { component.dispose(); }
});

function renderedFixture(): string {
	const values = [
		["quota", snapshot([account(), account({ label: "共同前缀👩‍💻é-very-long-account-two@example.invalid" })])],
		["balance", snapshot([account({ provider: "deepseek", windows: [], balance: { available: false, amounts: [
			{ currency: "USD", amount: 0 }, { currency: "EUR", amount: -1234.56 }, { currency: "CNY", amount: 12.34 }, { currency: "JPY", amount: 56.78 },
		] } })])],
	] as const;
	const sections: string[] = ["Synthetic renderer output; ANSI removed. Regenerate: UPDATE_LAYOUT_FIXTURES=1 node --import tsx --test test/layout.test.ts"];
	for (const [name, value] of values) for (const width of [30, 40, 80, 120]) {
		const { component } = details(value, 36);
		try {
			sections.push(`\n=== ${name} widget ${width} ===\n${widget(value, width).map(plain).join("\n")}`);
			sections.push(`\n=== ${name} details ${width} ===\n${component.render(width).map(plain).join("\n")}`);
		} finally { component.dispose(); }
	}
	return sections.join("\n") + "\n";
}

test("actual synthetic text snapshots are reproducible from the renderers", () => {
	const path = new URL("./fixtures/display-layout.txt", import.meta.url);
	const actual = renderedFixture();
	if (process.env.UPDATE_LAYOUT_FIXTURES === "1") writeFileSync(path, actual);
	assert.equal(actual, readFileSync(path, "utf8"));
});
