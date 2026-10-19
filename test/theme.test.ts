import assert from "node:assert/strict";
import test from "node:test";
import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { UsageDetailsComponent } from "../src/details-ui.js";
import { applyProviderRead, deriveUsageSnapshot } from "../src/state.js";
import { renderUsage } from "../src/ui.js";
import type { Theme, UiContext } from "../src/types.js";

const value = deriveUsageSnapshot({ provider: "claude", enabled: true, configuration: { status: "ready" },
	record: applyProviderRead(undefined, { provider: "claude", discovery: "success", items: [{
		provider: "claude", label: "synthetic", queried: true, windows: [
			{ label: "7d", used: 50 }, { label: "5h", used: 71 }, { label: "1h", used: 91 },
		],
	}] }, { attemptedAt: 0, completedAt: 0 }), now: 0, maxAgeMs: 300_000, refreshing: false,
});

function palette() {
	let light = false;
	const tokens = ["text", "accent", "muted", "dim", "success", "warning", "error", "border"];
	const code = (color: string, useLight = light) => `\x1b[38;5;${(useLight ? 100 : 20) + tokens.indexOf(color)}m`;
	// Models the public callback theme's stable handle: calls resolve current colors.
	const theme: Theme = { fg: (color, text) => `${code(color)}${text}\x1b[0m` };
	return { theme, code, switch() { light = true; }, oldCodes: () => tokens.map((color) => code(color, false)) };
}

for (const view of ["widget", "details"] as const) {
	test(`${view} same instance repaints the active semantic theme without old ANSI`, () => {
		const p = palette();
		let content: unknown;
		const ctx: UiContext = { mode: "tui", ui: { theme: p.theme,
			setWidget(_id, next) { content = next; }, setStatus() {}, notify() {}, select: async () => undefined, input: async () => undefined,
		} };
		const tui = { terminal: { rows: 40 }, requestRender() {} } as unknown as TUI;
		renderUsage(ctx, value, 4);
		const component = view === "widget"
			? (content as (tui: unknown, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void })(tui, p.theme)
			: new UsageDetailsComponent(tui, p.theme as PiTheme, { getSnapshot: () => value, onClose() {}, onRefresh() {} });
		try {
			const dark = component.render(120).join("\n");
			assert.ok(dark.includes(`${p.code(view === "widget" ? "text" : "accent")}Claude`), dark);
			assert.doesNotMatch(dark, /\x1b\[38;5;208m/);
			for (const [color, field] of [["success", "left 50%"], ["warning", "left 29%"], ["error", "left 9%"]]) {
				assert.ok(dark.includes(`${p.code(color!)}${field}`), `${color}: ${dark}`);
			}
			p.switch();
			component.invalidate();
			const light = component.render(120).join("\n");
			assert.ok(light.includes(`${p.code(view === "widget" ? "text" : "accent")}Claude`), light);
			for (const old of p.oldCodes()) assert.equal(light.includes(old), false, old);
			for (const [color, field] of [["success", "left 50%"], ["warning", "left 29%"], ["error", "left 9%"]]) {
				assert.ok(light.includes(`${p.code(color!)}${field}`), `${color}: ${light}`);
			}
		} finally { component.dispose?.(); }
	});
}
