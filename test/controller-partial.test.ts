import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("successful partial HTTP clears network backoff without claiming complete data success", async (t) => {
	const start = Date.UTC(2030, 0, 1);
	t.mock.timers.enable({ apis: ["Date"], now: start });
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-partial-controller-"));
	const paths = { settingsPath: join(dir, "settings.json"), legacySettingsPath: join(dir, "old.json"), providerConfigPath: join(dir, "provider.json") };
	await writeFile(paths.settingsPath, JSON.stringify({ ...DEFAULT_SETTINGS, managementUrl: "https://synthetic.invalid", managementKey: "synthetic-only" }));
	let phase: "complete" | "failed" | "partial" = "complete";
	let requests = 0;
	t.mock.method(globalThis, "fetch", async (input: unknown) => {
		requests++;
		if (String(input).endsWith("/auth-files")) return Response.json({ files: [{ provider: "codex", auth_index: "a" }] });
		if (phase === "failed") return Response.json({ status_code: 503 });
		return Response.json({ status_code: 200, body: { rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800 },
			...(phase === "partial" ? { secondary_window: { used_percent: "bad" } } : {}) } } });
	});
	const ctx = { mode: "tui", hasUI: true, model: { provider: "cliproxyapi", id: "gpt-5" },
		ui: { theme: { fg: (_color: string, text: string) => text }, setWidget() {}, setStatus() {}, notify() {} } } as unknown as ExtensionContext;
	const controller = new UsageController(paths);
	try {
		await controller.refreshCurrent(ctx);
		assert.equal(controller.getSnapshot(ctx).lastCompleteSuccessAt, start);
		t.mock.timers.tick(1000); phase = "failed";
		await controller.refreshCurrent(ctx, { force: true });
		assert.ok(controller.getSnapshot(ctx).eligibility?.backoffUntil);
		t.mock.timers.tick(1000); phase = "partial";
		await controller.refreshCurrent(ctx, { force: true });
		const subset = controller.getSnapshot(ctx);
		assert.equal(subset.state, "ready");
		assert.equal(subset.error, undefined);
		assert.equal(subset.partial, true);
		assert.equal(subset.accounts[0]?.incomplete, true);
		assert.equal(subset.accounts[0]?.lastValidAt, start + 2000);
		assert.equal(subset.lastCompleteSuccessAt, start);
		assert.equal(subset.eligibility?.backoffUntil, undefined);
		t.mock.timers.tick(1000); phase = "complete";
		await controller.refreshCurrent(ctx);
		assert.equal(controller.getSnapshot(ctx).partial, false);
		assert.equal(controller.getSnapshot(ctx).accounts[0]?.incomplete, undefined);
		assert.equal(controller.getSnapshot(ctx).lastCompleteSuccessAt, start + 3000);
		assert.equal(requests, 8);
	} finally { controller.shutdown(ctx); await rm(dir, { recursive: true, force: true }); }
});
