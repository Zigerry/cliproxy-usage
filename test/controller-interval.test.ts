import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";

const START = Date.UTC(2030, 0, 1);

for (const minutes of [35791, 35792, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e100, Infinity, 1.5, 0]) {
	test(`controller schedules and advertises the same safe interval for ${minutes}`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
		const delays: number[] = [];
		const clockInterval = globalThis.setInterval;
		t.mock.method(globalThis, "setInterval", (callback: () => void, delay: number) => {
			delays.push(delay);
			return clockInterval(callback, delay);
		});
		const dir = await mkdtemp(join(tmpdir(), "cliproxy-interval-"));
		const paths = { settingsPath: join(dir, "settings.json"), legacySettingsPath: join(dir, "legacy.json"), providerConfigPath: join(dir, "provider.json") };
		const settings = { ...structuredClone(DEFAULT_SETTINGS), refreshMinutes: minutes,
			managementUrl: "https://management.example.invalid", managementKey: "synthetic-only" };
		await writeFile(paths.settingsPath, JSON.stringify(settings));
		const loaded: LoadedSettings = { settings, raw: {}, path: paths.settingsPath, writable: true, warnings: [] };
		const ctx = {
			model: { provider: "cliproxyapi", id: "gpt-5" }, mode: "tui", hasUI: true,
			ui: { theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text }, setWidget() {}, setStatus() {}, notify() {} },
		} as unknown as ExtensionContext;
		let requests = 0;
		let periodicEntered: (() => void) | undefined;
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			requests++;
			if (String(input).endsWith("/auth-files")) {
				periodicEntered?.();
				return Response.json({ files: [{ provider: "codex", auth_index: "synthetic" }] });
			}
			return Response.json({ status_code: 200, body: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } } } });
		});
		const controller = new UsageController(paths);
		t.after(async () => { controller.shutdown(ctx); await rm(dir, { recursive: true, force: true }); });
		controller.start(ctx, loaded);
		await controller.refreshCurrent(ctx, { loaded }); // public queue barrier
		const effectiveMinutes = minutes === 35791 ? minutes : 5;
		const interval = effectiveMinutes * 60_000;
		assert.ok(delays.length > 0);
		for (const delay of delays) {
			assert.equal(delay, interval);
			assert.ok(Number.isSafeInteger(delay) && delay >= 1 && delay <= 2_147_483_647);
		}
		assert.equal(controller.getSnapshot(ctx).eligibility?.nextAutomaticCheckAt, START + interval);
		assert.equal(controller.getSnapshot(ctx, START + interval - 1).stale, false);
		assert.equal(controller.getSnapshot(ctx, START + interval).stale, true, "freshness uses the same effective interval");
		const before = requests;
		t.mock.timers.tick(1000);
		assert.equal(requests, before, "invalid intervals must not create a 1ms refresh loop");
		const schedules = delays.length;
		for (const showWidget of [false, true]) {
			await controller.applySettings(ctx, { ...settings, refreshMinutes: effectiveMinutes, showWidget }, "showWidget");
		}
		assert.equal(delays.length, schedules, "visibility alone must not re-anchor the interval");
		assert.equal(controller.getSnapshot(ctx).eligibility?.nextAutomaticCheckAt, START + interval);
		t.mock.timers.tick(interval - 1001);
		assert.equal(requests, before);
		const entered = new Promise<void>((resolve) => { periodicEntered = resolve; });
		t.mock.timers.tick(1);
		assert.equal(controller.getSnapshot(ctx).eligibility?.nextAutomaticCheckAt, START + 2 * interval);
		await entered; // Prove the scheduled callback, not the barrier, starts HTTP.
		await controller.refreshCurrent(ctx);
		assert.ok(requests > before);

		// Other public adoption paths must also use the same freshness duration.
		await controller.applySettings(ctx, settings, "refreshMinutes");
		assert.equal(delays.at(-1), interval);
		assert.equal(controller.getSnapshot(ctx, START + 2 * interval).stale, true);
		controller.syncSettings(settings, ctx);
		assert.equal(controller.getSnapshot(ctx, START + 2 * interval).stale, true);
	});
}
