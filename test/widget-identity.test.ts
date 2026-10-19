import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderRead, deriveUsageSnapshot } from "../src/state.js";
import { renderUsage } from "../src/ui.js";
import type { Theme, UiContext } from "../src/types.js";

test("widget disambiguates empty and literal fallback account labels at all ordinary widths", () => {
	const record = applyProviderRead(undefined, { provider: "codex", discovery: "success", items: ["", "remote"].map((label, i) => ({
		provider: "codex", accountId: `private-id-${i}`, label, queried: true, windows: [{ label: "7d", used: 10 + i * 10 }],
	})) }, { attemptedAt: 0, completedAt: 0 });
	const snapshot = deriveUsageSnapshot({ provider: "codex", enabled: true, configuration: { status: "ready" }, record,
		refreshing: false, now: 0, maxAgeMs: 60_000 });
	const theme: Theme = { fg: (_color, text) => text };
	let content: unknown;
	const ctx: UiContext = { mode: "tui", ui: { theme, setWidget(_id, value) { content = value; }, setStatus() {}, notify() {}, select: async () => undefined, input: async () => undefined } };
	renderUsage(ctx, snapshot, 4);
	const component = (content as (tui: unknown, theme: Theme) => { render(width: number): string[] })(undefined, theme);
	for (const width of [30, 40, 80, 100, 120]) {
		const text = component.render(width).join("\n");
		assert.match(text, /rem(?:ote|…) #1/);
		assert.match(text, /rem(?:ote|…) #2/);
		assert.match(text, /left 90%/);
		assert.match(text, /left 80%/);
		assert.doesNotMatch(text, /private-id-/);
	}
});
