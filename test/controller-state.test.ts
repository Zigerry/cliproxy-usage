import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";

const START = Date.UTC(2030, 0, 1);
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

type Phase = "valid" | "partial" | "unknown" | "failure" | "empty" | "auth" | "provider-auth";
async function harness(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-state-"));
	const originalFetch = globalThis.fetch;
	const paths = { settingsPath: join(dir, "settings.json"), legacySettingsPath: join(dir, "legacy.json"), providerConfigPath: join(dir, "provider.json") };
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.managementUrl = "https://management.example.invalid";
	settings.managementKey = "synthetic-only";
	const save = () => writeFile(paths.settingsPath, JSON.stringify(settings));
	await save();
	let widget: unknown;
	let publications = 0;
	let requests = 0;
	let model = { provider: "cliproxyapi", id: "gpt-5" };
	let phase: Phase = "valid";
	let resetAt: number | undefined;
	let detail: { render(width: number): string[]; handleInput(data: string): void; dispose(): void } | undefined;
	let detailOpen = false;
	const notifications: string[] = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		get model() { return model; }, mode: "tui", hasUI: true,
		ui: {
			theme,
			setWidget: (_id: string, content: unknown) => { widget = content; publications++; },
			setStatus() {}, notify: (message: string) => { notifications.push(message); },
			custom: (factory: (...args: any[]) => any) => new Promise<void>((resolve) => {
				const done = () => { detailOpen = false; detail?.dispose(); resolve(); };
				detail = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, {}, done);
				detailOpen = true;
			}),
		},
	} as unknown as ExtensionCommandContext;
	const reply = (input: unknown, init?: RequestInit): Response => {
		if (String(input).endsWith("/auth-files")) {
			if (phase === "failure" || phase === "auth") return new Response("", { status: phase === "auth" ? 401 : 503 });
			return Response.json({ files: phase === "empty" ? [] : ["a", "b"].map((auth_index) => ({ provider: "codex", auth_index, label: auth_index })) });
		}
		const id = JSON.parse(String(init?.body)).auth_index;
		if (phase === "provider-auth") return Response.json({ status_code: 401 });
		if (phase === "partial" && id === "b") return Response.json({ status_code: 503 });
		if (phase === "unknown" && id === "b") return Response.json({ status_code: 200, body: {} });
		return Response.json({ status_code: 200, body: { rate_limit: { primary_window: {
			used_percent: id === "a" ? 20 : 40, limit_window_seconds: 604800, reset_at: resetAt,
		} } } });
	};
	let handler: (input: unknown, init?: RequestInit) => Response | Promise<Response> = reply;
	globalThis.fetch = async (input, init) => { requests++; return handler(input, init); };
	const controller = new UsageController(paths);
	t.after(async () => {
		controller.shutdown(ctx);
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});
	return {
		controller, ctx, settings, paths, save, notifications, reply,
		loaded(): LoadedSettings { return { settings: structuredClone(settings), raw: {}, path: paths.settingsPath, writable: true, warnings: [] }; },
		get phase() { return phase; }, set phase(value: Phase) { phase = value; },
		set handler(value: typeof handler) { handler = value; },
		set resetAt(value: number | undefined) { resetAt = value; },
		get requests() { return requests; }, get publications() { return publications; }, get detailOpen() { return detailOpen; },
		setModel(id: string) { model = { provider: "cliproxyapi", id }; },
		refresh: () => controller.refreshCurrent(ctx),
		snapshot: () => controller.getSnapshot(ctx),
		details: () => detail?.render(100).join("\n") ?? "",
		render() {
			if (!widget) return "";
			const factory = widget as (tui: unknown, theme: typeof ctx.ui.theme) => { render(width: number): string[] };
			return factory(undefined, ctx.ui.theme).render(200).join("\n");
		},
	};
}

test("partial refresh advances only successful account valid times, never full-success time", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	await h.refresh();
	assert.equal(h.snapshot().lastCompleteSuccessAt, START);
	t.mock.timers.setTime(START + 120_000);
	h.phase = "partial";
	await h.refresh();
	const snapshot = h.snapshot();
	assert.equal(snapshot.state, "ready");
	assert.equal(snapshot.partial, true);
	assert.equal(snapshot.stale, true);
	assert.equal(snapshot.lastCompleteSuccessAt, START);
	assert.equal(snapshot.accounts.find((a) => a.accountId === "a")?.lastValidAt, START + 120_000);
	assert.equal(snapshot.accounts.find((a) => a.accountId === "b")?.lastValidAt, START);
	assert.equal(snapshot.accounts.find((a) => a.accountId === "b")?.attemptedAt, START + 120_000);
	assert.equal(snapshot.accounts.find((a) => a.accountId === "b")?.cached, true);
	assert.match(h.render().toLowerCase(), /partial|stale|cached/);
});

test("unknown response hides old data and discovery failure does not fabricate account attempts", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	await h.refresh();
	t.mock.timers.setTime(START + 60_000);
	h.phase = "unknown";
	await h.refresh();
	const unknown = h.snapshot().accounts.find((a) => a.accountId === "b")!;
	assert.equal(unknown.result, "unknown");
	assert.deepEqual(unknown.windows, []);
	assert.equal(unknown.balance, undefined);
	assert.equal(unknown.lastValidAt, START);
	t.mock.timers.setTime(START + 120_000);
	h.phase = "failure";
	await h.refresh();
	const failed = h.snapshot();
	assert.equal(failed.state, "error");
	assert.equal(failed.lastAttemptAt, START + 120_000);
	assert.equal(failed.accounts.find((a) => a.accountId === "a")?.attemptedAt, START + 60_000);
	assert.deepEqual(failed.accounts.find((a) => a.accountId === "b")?.windows, []);
	h.phase = "empty";
	await h.refresh();
	assert.equal(h.snapshot().state, "empty");
	assert.deepEqual(h.snapshot().accounts, []);
	assert.match(h.render().toLowerCase(), /no .*accounts|no accounts/);
});

test("loading and background refresh are visible without erasing cached quota", async (t) => {
	const h = await harness(t);
	let entered = deferred<void>();
	let release = deferred<void>();
	let block = true;
	h.handler = async (input, init) => {
		if (block && String(input).endsWith("/auth-files")) { entered.resolve(); await release.promise; }
		return h.reply(input, init);
	};
	const initial = h.refresh();
	await entered.promise;
	assert.equal(h.snapshot().state, "loading");
	assert.match(h.render().toLowerCase(), /loading|refreshing/);
	block = false;
	release.resolve();
	await initial;
	entered = deferred<void>(); release = deferred<void>(); block = true;
	const background = h.refresh();
	await entered.promise;
	assert.equal(h.snapshot().refreshing, true);
	assert.equal(h.snapshot().state, "ready");
	assert.match(h.render(), /left 80%/);
	assert.match(h.render().toLowerCase(), /refreshing/);
	block = false; release.resolve(); await background;
});

test("configuration and Management auth facts classify setup, never provider error strings", async (t) => {
	const h = await harness(t);
	h.settings.managementKey = "";
	await h.save(); h.controller.resetSettings(h.settings, h.ctx);
	await h.refresh();
	assert.equal(h.requests, 0);
	assert.equal(h.snapshot().state, "setup-required");
	const missing = h.snapshot().configuration;
	assert.equal(missing.status === "setup-required" ? missing.reason : undefined, "missing-key");
	h.settings.managementKey = "synthetic-only";
	await h.save(); h.controller.resetSettings(h.settings, h.ctx);
	await h.refresh();
	h.phase = "provider-auth";
	await h.refresh();
	assert.equal(h.snapshot().state, "error");
	assert.equal(h.snapshot().configuration.status, "ready");
	h.phase = "auth";
	await h.refresh();
	assert.equal(h.snapshot().state, "setup-required");
	const configuration = h.snapshot().configuration;
	assert.equal(configuration.status === "setup-required" ? configuration.reason : undefined, "rejected");
	const count = h.requests;
	await h.refresh();
	assert.equal(h.requests, count);
});

for (const [url, reason] of [["", "missing-url"], ["invalid-url", "invalid-source"]] as const) {
	test(`configuration classifies ${reason} without issuing provider requests`, async (t) => {
		const h = await harness(t);
		h.settings.managementUrl = url;
		await h.save(); h.controller.resetSettings(h.settings, h.ctx);
		await h.refresh();
		const snapshot = h.snapshot();
		assert.equal(snapshot.state, "setup-required");
		assert.equal(snapshot.configuration.status === "setup-required" ? snapshot.configuration.reason : undefined, reason);
		assert.equal(h.requests, 0);
		assert.equal(snapshot.stale, false);
		await h.controller.showStatus(h.ctx);
		assert.equal(h.requests, 0);
		assert.match(h.notifications.at(-1) ?? "", /cliproxy-usage settings/);
	});
}

test("snapshot and status are detached, cache-backed, and expose no credential", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	h.resetAt = (START + 3_600_000) / 1000;
	await h.refresh();
	const snapshot = h.snapshot();
	snapshot.accounts[0]!.windows[0]!.resetsAt!.setTime(0);
	assert.equal(h.snapshot().accounts[0]?.windows[0]?.resetsAt?.getTime(), START + 3_600_000);
	const requests = h.requests;
	await h.controller.showStatus(h.ctx);
	assert.equal(h.requests, requests);
	assert.match(h.notifications.at(-1) ?? "", /Usage state: ready/);
	assert.match(h.notifications.at(-1) ?? "", /Last refresh:/);
	assert.equal(JSON.stringify(h.snapshot()).includes(h.settings.managementKey), false);
	assert.equal(h.notifications.join("\n").includes(h.settings.managementKey), false);
});

for (const boundary of ["age", "reset"] as const) {
	test(`${boundary} expiry redraws stale without HTTP or timestamp mutation`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
		const h = await harness(t);
		if (boundary === "reset") h.resetAt = (START + 60_000) / 1000;
		await h.refresh();
		const requests = h.requests;
		const before = h.publications;
		const delay = boundary === "age" ? 300_000 : 60_000;
		t.mock.timers.tick(delay - 1);
		assert.equal(h.snapshot().stale, false);
		t.mock.timers.tick(1);
		assert.equal(h.snapshot().stale, true);
		assert.ok(h.publications > before);
		assert.match(h.render().toLowerCase(), /stale/);
		assert.equal(h.requests, requests);
		assert.equal(h.snapshot().lastCompleteSuccessAt, START);
		assert.equal(h.snapshot().accounts[0]?.lastValidAt, START);
		const expiredPublications = h.publications;
		t.mock.timers.tick(120_000);
		assert.equal(h.publications, expiredPublications);
		assert.equal(h.requests, requests);
	});
}

test("refresh interval changes recompute freshness immediately and cleanup prevents old repaint", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
	const h = await harness(t);
	await h.refresh();
	const requests = h.requests;
	t.mock.timers.tick(120_000);
	h.settings.refreshMinutes = 1;
	await h.save();
	await h.controller.applySettings(h.ctx, h.settings, "refreshMinutes");
	assert.equal(h.snapshot().stale, true);
	assert.match(h.render().toLowerCase(), /stale/);
	assert.equal(h.requests, requests);
	h.controller.shutdown(h.ctx);
	const count = h.publications;
	t.mock.timers.tick(600_000);
	assert.equal(h.publications, count);
	assert.equal(h.requests, requests);
});

for (const action of ["model", "reset", "disable"] as const) {
	test(`${action} clears expiry ownership without touching an expired context or making HTTP`, async (t) => {
		t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
		const h = await harness(t);
		let expired = false;
		const oldContext = new Proxy(h.ctx, { get(target, key, receiver) {
			if (expired) throw new Error("expired expiry context accessed");
			return Reflect.get(target, key, receiver);
		} });
		await h.controller.refreshCurrent(oldContext);
		const requests = h.requests;
		if (action === "model") { h.setModel("o3"); h.controller.modelSelected(h.ctx, undefined); }
		else if (action === "reset") h.controller.resetSettings(h.settings, h.ctx);
		else {
			h.settings.providers.codex = false;
			await h.save();
			await h.controller.applySettings(h.ctx, h.settings, "codex");
		}
		expired = true;
		const count = h.publications;
		t.mock.timers.tick(600_000);
		assert.equal(h.publications, count);
		assert.equal(h.requests, requests);
	});
}

test("provider change, reset and source change close details instead of freezing an old view", async (t) => {
	const h = await harness(t);
	await h.refresh();
	let view = h.controller.showDetails(h.ctx);
	assert.equal(h.detailOpen, true);
	h.setModel("gpt-4o"); h.controller.modelSelected(h.ctx, "codex");
	assert.equal(h.detailOpen, true);
	h.setModel("o3"); h.controller.modelSelected(h.ctx, undefined);
	await view;
	assert.equal(h.detailOpen, false);
	assert.equal(h.render(), "");
	h.setModel("gpt-5"); h.controller.modelSelected(h.ctx, "codex");
	view = h.controller.showDetails(h.ctx);
	h.controller.resetSettings(h.settings, h.ctx);
	await view;
	assert.equal(h.detailOpen, false);
	await h.refresh();
	view = h.controller.showDetails(h.ctx);
	h.settings.managementUrl = "https://second.example.invalid";
	await h.save(); await h.refresh();
	await view;
	assert.equal(h.detailOpen, false);
});

test("partial and cached-error state agrees across widget, details, status and notifications", async (t) => {
	const h = await harness(t);
	await h.refresh(); h.phase = "partial"; await h.refresh();
	const view = h.controller.showDetails(h.ctx);
	assert.match(h.render().toLowerCase(), /partial|cached|stale/);
	assert.match(h.details().toLowerCase(), /partial|cached|stale/);
	await h.controller.showStatus(h.ctx);
	assert.match(h.notifications.at(-1)?.toLowerCase() ?? "", /partial|cached|stale/);
	await h.controller.refreshCurrent(h.ctx, { notify: true });
	assert.match(h.notifications.at(-1)?.toLowerCase() ?? "", /partial|cached|stale/);
	h.controller.resetSettings(h.settings, h.ctx); await view;
});
