import assert from "node:assert/strict";
import test from "node:test";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { UsageDetailsComponent } from "../src/details-ui.js";
import { applyProviderRead, deriveUsageSnapshot } from "../src/state.js";
import { formatSnapshotDetails, renderUsage } from "../src/ui.js";
import type { Theme, UiContext } from "../src/types.js";

for (const provider of ["codex", "deepseek"] as const) for (const cached of [false, true]) test(`all shared views annotate ${cached ? "cached" : "current"} ${provider} subset data explicitly`, () => {
	let record = applyProviderRead(undefined, { provider, discovery: "success", items: [{ provider, accountId: "a", label: "a", queried: true,
		incomplete: true, windows: provider === "codex" ? [{ label: "7d", used: 0 }] : [],
		...(provider === "deepseek" ? { balance: { available: true, amounts: [{ currency: "USD", amount: 0 }, { currency: "CNY", amount: -1 }] } } : {}) }] }, { attemptedAt: 100, completedAt: 110 });
	if (cached) record = applyProviderRead(record, { provider, discovery: "success", items: [{ provider, accountId: "a", label: "a", queried: true,
		windows: [], error: "HTTP 503" }] }, { attemptedAt: 200, completedAt: 210 });
	const snapshot = deriveUsageSnapshot({ provider, enabled: true, configuration: { status: "ready" }, record, refreshing: false, now: 300, maxAgeMs: 60_000 });
	const theme: Theme = { fg: (_color, text) => text };
	let content: unknown;
	const ctx = { ui: { setWidget: (_id: string, value: unknown) => { content = value; } } } as unknown as UiContext;
	renderUsage(ctx, snapshot, 4);
	const component = new UsageDetailsComponent({ terminal: { rows: 60 }, requestRender() {} } as unknown as TUI, theme as PiTheme,
		{ getSnapshot: () => snapshot, onRefresh() {}, onClose() {} });
	try {
		for (const width of [30, 80, 120]) {
			const widget = (content as (tui: unknown, theme: Theme) => { render(width: number): string[] })(undefined, theme).render(width).join("\n");
			for (const text of [widget, component.render(width).join("\n"), formatSnapshotDetails(snapshot)]) {
				assert.match(text, /partial data/);
				if (provider === "codex") assert.match(text, /left 100%/);
				else { assert.match(text, /\$0\.00/); assert.match(text, /¥-1\.00/); assert.doesNotMatch(text, /left/); }
				if (cached) { assert.match(text, /cached/); assert.match(text, /HTTP 503/); }
			}
		}
	} finally { component.dispose(); }
});

test("unknown current payloads expose their partial warning but never historical subset numbers", () => {
	const previous = applyProviderRead(undefined, { provider: "codex", discovery: "success", items: [{ provider: "codex", accountId: "a", label: "a", queried: true,
		incomplete: true, windows: [{ label: "7d", used: 0 }] }] }, { attemptedAt: 100, completedAt: 110 });
	const record = applyProviderRead(previous, { provider: "codex", discovery: "success", items: [{ provider: "codex", accountId: "a", label: "a", queried: true,
		incomplete: true, windows: [] }] }, { attemptedAt: 200, completedAt: 210 });
	const snapshot = deriveUsageSnapshot({ provider: "codex", enabled: true, configuration: { status: "ready" }, record, refreshing: false, now: 300, maxAgeMs: 60_000 });
	const theme: Theme = { fg: (_color, text) => text };
	let content: unknown;
	renderUsage({ ui: { setWidget: (_id: string, value: unknown) => { content = value; } } } as unknown as UiContext, snapshot, 4);
	const details = new UsageDetailsComponent({ terminal: { rows: 60 }, requestRender() {} } as unknown as TUI, theme as PiTheme,
		{ getSnapshot: () => snapshot, onRefresh() {}, onClose() {} });
	try {
		for (const text of [formatSnapshotDetails(snapshot), details.render(80).join("\n"),
			(content as (tui: unknown, theme: Theme) => { render(width: number): string[] })(undefined, theme).render(80).join("\n")]) {
			assert.match(text, /partial data/);
			assert.match(text, /unknown/);
			assert.doesNotMatch(text, /left|100%|cached/);
		}
	} finally { details.dispose(); }
});
