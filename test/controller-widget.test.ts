import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";
import type { Settings } from "../src/types.js";

const START = Date.UTC(2030, 0, 1);
type DisplaySettings = Settings & { showWidget: boolean };
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
async function harness(t: TestContext) {
	const dir = await fs.mkdtemp(join(tmpdir(), "cliproxy-widget-"));
	const paths = { settingsPath: join(dir, "settings.json"), legacySettingsPath: join(dir, "legacy.json"), providerConfigPath: join(dir, "provider.json") };
	const settings = structuredClone(DEFAULT_SETTINGS) as DisplaySettings;
	settings.showWidget = true;
	settings.managementUrl = "https://management.example.invalid";
	settings.managementKey = "synthetic-only";
	const save = () => fs.writeFile(paths.settingsPath, JSON.stringify(settings));
	await save();
	await fs.writeFile(paths.providerConfigPath, JSON.stringify({ baseUrl: settings.managementUrl }));
	let widget: unknown;
	let publications = 0;
	let requests = 0;
	let wait = false;
	let detail: { dispose(): void; render(width: number): string[]; handleInput(data: string): void } | undefined;
	let detailOpen = false;
	const notices: string[] = [];
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const ctx = {
		model: { provider: "cliproxyapi", id: "gpt-5" }, mode: "tui", hasUI: true,
		ui: { theme, setStatus() {}, notify(message: string) { notices.push(message); },
			setWidget(_id: string, value: unknown) { widget = value; publications++; },
			custom: (factory: (...args: any[]) => any) => new Promise<void>((resolve) => {
				detail = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, {}, () => {
					detailOpen = false; detail?.dispose(); resolve();
				});
				detailOpen = true;
			}),
		},
	} as unknown as ExtensionCommandContext;
	const reply = (input: unknown): Response => String(input).endsWith("/auth-files")
		? Response.json({ files: [{ provider: "codex", auth_index: "a", label: "synthetic" }] })
		: wait ? Response.json({ status_code: 429, header: { "Retry-After": "600" } })
			: Response.json({ status_code: 200, body: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: (START + 60_000) / 1000 } } } });
	let handler: (input: unknown, init?: RequestInit) => Response | Promise<Response> = reply;
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => { requests++; return handler(input, init); });
	const controller = new UsageController(paths);
	t.after(async () => { controller.shutdown(ctx); t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(dir, { recursive: true, force: true }); });
	const loaded = (): LoadedSettings => ({ settings: structuredClone(settings), raw: {}, path: paths.settingsPath, warnings: [], writable: true });
	const refresh = (force = false) => controller.refreshCurrent(ctx, { force, loaded: loaded() });
	const toggle = async (visible: boolean) => {
		settings.showWidget = visible;
		await save();
		await controller.applySettings(ctx, settings, "showWidget");
	};
	return { controller, ctx, settings, paths, loaded, save, refresh, toggle, notices, reply,
		get widget() { return widget; }, get publications() { return publications; }, get requests() { return requests; },
		get detailOpen() { return detailOpen; }, detail: () => detail,
		set wait(value: boolean) { wait = value; }, set handler(value: typeof handler) { handler = value; },
	};
}

test("visibility toggle preserves periodic anchor, cache and open details; hidden periodic HTTP continues", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
	const h = await harness(t);
	h.controller.start(h.ctx, h.loaded());
	await h.refresh();
	const before = h.controller.getSnapshot(h.ctx);
	const view = h.controller.showDetails(h.ctx);
	assert.equal(h.detailOpen, true);
	const count = h.requests;
	t.mock.timers.tick(30_000);
	await h.toggle(false);
	assert.equal(h.widget, undefined);
	assert.equal(h.requests, count);
	assert.equal(h.detailOpen, true);
	assert.equal(h.controller.getSnapshot(h.ctx).eligibility?.nextAutomaticCheckAt, before.eligibility?.nextAutomaticCheckAt);
	assert.deepEqual(h.controller.getSnapshot(h.ctx).accounts, before.accounts);
	assert.match(h.detail()?.render(80).join("\n") ?? "", /left 80%/);
	const publications = h.publications;
	t.mock.timers.tick(30_000);
	assert.equal(h.publications, publications, "hidden widget has no expiry redraw");
	const periodicStarted = deferred<void>();
	h.handler = (input) => { if (String(input).endsWith("/auth-files")) periodicStarted.resolve(); return h.reply(input); };
	t.mock.timers.tick(240_000);
	await periodicStarted.promise; // Prove the timer itself started HTTP, before any queue barrier.
	await h.refresh();
	assert.ok(h.requests > count, "periodic refresh policy still runs while hidden");
	assert.equal(h.widget, undefined);
	const hidden = h.controller.getSnapshot(h.ctx);
	const afterReads = h.requests;
	await h.toggle(true);
	assert.notEqual(h.widget, undefined);
	assert.equal(h.requests, afterReads);
	assert.equal(h.controller.getSnapshot(h.ctx).eligibility?.nextAutomaticCheckAt, hidden.eligibility?.nextAutomaticCheckAt);
	h.detail()?.handleInput("\u001b");
	await view;
});

test("visibility does not cancel an in-flight quota query or remove its result", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	await h.refresh();
	const entered = deferred<void>();
	const release = deferred<void>();
	let signal: AbortSignal | undefined;
	h.handler = async (input, init) => {
		if (String(input).endsWith("/api-call")) { signal = init?.signal ?? undefined; entered.resolve(); await release.promise; }
		return h.reply(input);
	};
	const old = h.refresh();
	await entered.promise;
	let toggle: Promise<void> | undefined;
	try {
		h.settings.showWidget = false; await h.save();
		toggle = h.controller.applySettings(h.ctx, h.settings, "showWidget");
		assert.equal(h.widget, undefined);
		assert.equal(signal?.aborted, false);
		assert.equal(h.controller.getSnapshot(h.ctx).refreshing, true);
	} finally { release.resolve(); }
	await Promise.all([old, toggle]);
	assert.equal(h.widget, undefined);
	assert.equal(h.controller.getSnapshot(h.ctx).state, "ready");
	assert.equal(h.controller.getSnapshot(h.ctx).accounts[0]?.lastValidAt, START);
	assert.equal(h.controller.getSnapshot(h.ctx).eligibility?.nextAutomaticCheckAt, undefined, "a display toggle must not create an automatic schedule");
});

for (const paused of ["settings", "source"] as const) {
	test(`new visibility wins after paused ${paused} read and old queued loaded settings`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: START });
		const h = await harness(t);
		await h.refresh();
		const oldLoaded = h.loaded();
		const entered = deferred<void>();
		const release = deferred<void>();
		const original = fs.readFile;
		let held = false;
		t.mock.method(fs, "readFile", async (...args: any[]) => {
			const value = await (original as (...args: any[]) => Promise<unknown>)(...args);
			if (!held && String(args[0]) === (paused === "settings" ? h.paths.settingsPath : h.paths.providerConfigPath)) {
				held = true; entered.resolve(); await release.promise;
			}
			return value;
		});
		syncBuiltinESMExports();
		const running = h.controller.refreshCurrent(h.ctx);
		await entered.promise;
		const pending = h.controller.refreshCurrent(h.ctx, { loaded: oldLoaded });
		let off: Promise<void> | undefined;
		let on: Promise<void> | undefined;
		let finalOff: Promise<void> | undefined;
		let latest: Promise<void> | undefined;
		try {
			h.settings.showWidget = false; await h.save(); off = h.controller.applySettings(h.ctx, h.settings, "showWidget");
			h.settings.showWidget = true; await h.save(); on = h.controller.applySettings(h.ctx, h.settings, "showWidget");
			h.settings.showWidget = false; await h.save(); finalOff = h.controller.applySettings(h.ctx, h.settings, "showWidget");
			// A new request merges with the old loaded snapshot: its newer display
			// revision must not be incorrectly attached to that inherited snapshot.
			latest = h.controller.refreshCurrent(h.ctx);
			assert.equal(h.widget, undefined);
		} finally { release.resolve(); }
		await Promise.all([running, pending, off, on, finalOff, latest]);
		assert.equal(h.widget, undefined, "obsolete load must not overwrite latest false");
		assert.equal(h.controller.getSnapshot(h.ctx).state, "ready");
		h.settings.showWidget = true; await h.save();
		await h.controller.refreshCurrent(h.ctx);
		assert.notEqual(h.widget, undefined, "later fresh config read adopts an external change");
	});
}

test("hiding preserves server wait and details refresh still honors D", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	await h.refresh(); h.wait = true; await h.refresh(true);
	const before = h.controller.getSnapshot(h.ctx);
	const count = h.requests;
	await h.toggle(false);
	const view = h.controller.showDetails(h.ctx);
	h.detail()?.handleInput("r");
	await h.refresh();
	assert.equal(h.requests, count);
	assert.equal(h.widget, undefined);
	assert.equal(h.detailOpen, true);
	assert.deepEqual(h.controller.getSnapshot(h.ctx).accounts, before.accounts);
	assert.equal(h.controller.getSnapshot(h.ctx).eligibility?.manualAllowedAt, before.eligibility?.manualAllowedAt);
	assert.match(h.detail()?.render(100).join("\n") ?? "", /server wait/);
	await h.controller.showStatus(h.ctx);
	assert.match(h.notices.at(-1) ?? "", /Widget: hidden/);
	h.detail()?.handleInput("\u001b"); await view;
});

test("paused read-only status cannot restore obsolete visibility; later status accepts external changes", async (t) => {
	const h = await harness(t);
	await h.refresh();
	const count = h.requests;
	const entered = deferred<void>();
	const release = deferred<void>();
	const original = fs.readFile;
	let held = false;
	t.mock.method(fs, "readFile", async (...args: any[]) => {
		const value = await (original as (...args: any[]) => Promise<unknown>)(...args);
		if (!held && String(args[0]) === h.paths.providerConfigPath) { held = true; entered.resolve(); await release.promise; }
		return value;
	});
	syncBuiltinESMExports();
	const status = h.controller.showStatus(h.ctx);
	await entered.promise;
	try { await h.toggle(false); } finally { release.resolve(); }
	await status;
	assert.equal(h.widget, undefined);
	assert.equal(h.requests, count);
	assert.match(h.notices.at(-1) ?? "", /Widget: hidden/);
	h.settings.showWidget = true; await h.save();
	await h.controller.showStatus(h.ctx);
	assert.notEqual(h.widget, undefined);
	assert.equal(h.requests, count);
	assert.match(h.notices.at(-1) ?? "", /Widget: shown/);
});

test("visibility id cannot disguise a real source boundary or preserve obsolete HTTP ownership", async (t) => {
	const h = await harness(t);
	await h.refresh();
	const entered = deferred<void>();
	const release = deferred<void>();
	let oldSignal: AbortSignal | undefined;
	let held = false;
	h.handler = async (input, init) => {
		if (!held && String(input).endsWith("/api-call")) {
			held = true; oldSignal = init?.signal ?? undefined; entered.resolve(); await release.promise;
		}
		return h.reply(input);
	};
	const old = h.refresh();
	await entered.promise;
	try {
		h.settings.showWidget = false;
		h.settings.managementUrl = "https://replacement.example.invalid";
		await h.save();
		await h.controller.applySettings(h.ctx, h.settings, "showWidget");
		assert.equal(oldSignal?.aborted, true);
		assert.equal(h.widget, undefined);
		assert.equal(h.controller.getSnapshot(h.ctx).state, "ready");
	} finally { release.resolve(); }
	await old;
});

test("combined provider/visibility changes preserve live server waits on disable and re-enable", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	await h.refresh(); h.wait = true; await h.refresh(true);
	const count = h.requests;
	for (const enabled of [false, true]) {
		h.settings.providers.codex = enabled;
		h.settings.showWidget = enabled;
		await h.save();
		await h.controller.applySettings(h.ctx, h.settings, "showWidget");
	}
	await h.refresh(true);
	assert.equal(h.requests, count);
	assert.equal(h.controller.getSnapshot(h.ctx).eligibility?.manualAllowedAt, START + 600_000);
});
