import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { initTheme, type ExtensionCommandContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";
import { showSettings } from "../src/settings-ui.js";

const START = Date.UTC(2030, 0, 1);
const SOURCE_A = "https://a.example.invalid";
const SOURCE_B = "https://b.example.invalid";
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function harness(t: TestContext) {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const dir = await fs.mkdtemp(join(tmpdir(), "cliproxy-observations-"));
	const paths = { settingsPath: join(dir, "settings.json"), legacySettingsPath: join(dir, "legacy.json"), providerConfigPath: join(dir, "provider.json") };
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.managementKey = "synthetic-only";
	const save = () => fs.writeFile(paths.settingsPath, JSON.stringify(settings));
	const source = (baseUrl: string) => fs.writeFile(paths.providerConfigPath, JSON.stringify({ baseUrl }));
	await save(); await source(SOURCE_A);
	const calls: string[] = [];
	const notices: string[] = [];
	let widget: unknown;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const ctx = {
		model: { provider: "cliproxyapi", id: "gpt-5" }, mode: "tui", hasUI: true,
		ui: { theme, setStatus() {}, setWidget(_id: string, value: unknown) { widget = value; }, notify(message: string) { notices.push(message); } },
	} as unknown as ExtensionCommandContext;
	let wait: "provider" | "management" | undefined;
	const reply = (input: unknown): Response => String(input).endsWith("/auth-files")
		? wait === "management" ? new Response("", { status: 429, headers: { "Retry-After": "600" } })
			: Response.json({ files: [{ provider: "codex", auth_index: "a", label: "synthetic" }] })
		: wait === "provider" ? Response.json({ status_code: 429, header: { "Retry-After": "600" } })
			: Response.json({ status_code: 200, body: { rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800 } } } });
	let handler: (input: unknown, init?: RequestInit) => Response | Promise<Response> = reply;
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => { calls.push(String(input)); return handler(input, init); });
	const controller = new UsageController(paths);
	t.after(async () => { controller.shutdown(ctx); t.mock.restoreAll(); syncBuiltinESMExports(); await fs.rm(dir, { recursive: true, force: true }); });
	const loaded = (): LoadedSettings => ({ settings: structuredClone(settings), raw: {}, path: paths.settingsPath, writable: true, warnings: [] });
	return { controller, ctx, settings, paths, save, source, loaded, calls, notices, reply,
		refresh: (force = false) => controller.refreshCurrent(ctx, { force }),
		snapshot: () => controller.getSnapshot(ctx),
		set wait(value: typeof wait) { wait = value; },
		set handler(value: typeof handler) { handler = value; },
		render: () => widget ? (widget as (tui: unknown, theme: typeof ctx.ui.theme) => Component)(undefined, ctx.ui.theme).render(240).join("\n") : "",
	};
}

/** Capture the actual read result, then defer only that observation, not later reads. */
function pauseRead(t: TestContext, path: string) {
	const entered = deferred<void>();
	const release = deferred<void>();
	const original = fs.readFile;
	let held = false;
	t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
		const value = await original(...args);
		if (!held && String(args[0]) === path) { held = true; entered.resolve(); await release.promise; }
		return value;
	});
	syncBuiltinESMExports();
	return { entered: entered.promise, release: () => release.resolve() };
}

for (const initial of [false, true]) {
	test(`obsolete status cannot discard a newer B server wait (initial boundary: ${initial})`, { timeout: 5000 }, async (t) => {
		const h = await harness(t);
		if (!initial) await h.refresh();
		// Keep settings identical even before the first source adoption, so the
		// initial case cannot rely on a credential-driven lifecycle invalidation.
		else h.controller.syncSettings(h.settings, h.ctx);
		const paused = pauseRead(t, h.paths.providerConfigPath);
		const status = h.controller.showStatus(h.ctx);
		await paused.entered;
		try {
			await h.source(SOURCE_B); h.wait = "provider";
			await h.refresh();
			assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
		} finally { paused.release(); }
		await status;
		assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
		assert.match(h.notices.at(-1) ?? "", /changed.*status|status.*again|retry.*status/i);
		const count = h.calls.length;
		await h.refresh(true);
		assert.equal(h.calls.length, count, "a stale read must not erase B's Retry-After");
		await h.controller.showStatus(h.ctx);
		assert.match(h.notices.at(-1) ?? "", /Management URL: https:\/\/b\.example\.invalid/);
		assert.equal(h.calls.length, count, "fresh status remains HTTP-free");
	});
}

test("obsolete status cannot cancel a newer B quota operation", { timeout: 5000 }, async (t) => {
	const h = await harness(t); await h.refresh();
	const paused = pauseRead(t, h.paths.providerConfigPath);
	const status = h.controller.showStatus(h.ctx); await paused.entered;
	await h.source(SOURCE_B);
	const entered = deferred<void>(); const release = deferred<void>();
	let signal: AbortSignal | undefined;
	h.handler = async (input, init) => {
		if (String(input).endsWith("/api-call")) { signal = init?.signal ?? undefined; entered.resolve(); await release.promise; }
		return h.reply(input);
	};
	h.wait = "provider";
	const refresh = h.refresh(); await entered.promise;
	try {
		paused.release(); await status;
		assert.equal(signal?.aborted, false);
		assert.equal(h.snapshot().refreshing, true);
	} finally { release.resolve(); }
	await refresh;
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
});

for (const stage of ["settings", "source"] as const) {
	test(`a newer initial status adoption supersedes paused refresh ${stage} and queued loaded settings`, { timeout: 5000 }, async (t) => {
		const h = await harness(t);
		h.controller.syncSettings(h.settings, h.ctx);
		const paused = pauseRead(t, stage === "settings" ? h.paths.settingsPath : h.paths.providerConfigPath);
		const old = h.refresh(); await paused.entered;
		const queued = h.controller.refreshCurrent(h.ctx, { loaded: h.loaded(), force: true });
		try {
			await h.source(SOURCE_B);
			await h.controller.showStatus(h.ctx);
			assert.equal(h.calls.length, 0);
		} finally { paused.release(); }
		await Promise.all([old, queued]);
		assert.equal(h.calls.length, 0, "superseded config observations must not initiate HTTP");
		await h.refresh();
		assert.equal(h.calls.length, 2);
		assert.ok(h.calls.every((url) => url.startsWith(SOURCE_B)));
		assert.equal(h.snapshot().state, "ready");
	});
}

for (const merge of ["inherit-old-loaded", "replace-with-new-loaded"] as const) {
	test(`queue observations stay paired with loaded settings (${merge})`, { timeout: 5000 }, async (t) => {
		const h = await harness(t); await h.refresh();
		const entered = deferred<void>(); const release = deferred<void>();
		let held = false; let signal: AbortSignal | undefined;
		h.handler = async (input, init) => {
			if (!held && String(input).endsWith("/api-call")) {
				held = true; signal = init?.signal ?? undefined; entered.resolve(); await release.promise;
			}
			return h.reply(input);
		};
		const running = h.refresh(); await entered.promise;
		const oldLoaded = h.controller.refreshCurrent(h.ctx, { loaded: h.loaded() });
		let merged: Promise<void> | undefined;
		const count = h.calls.length;
		try {
			h.settings.refreshMinutes = 1; await h.save();
			await h.controller.applySettings(h.ctx, h.settings, "refreshMinutes");
			assert.equal(signal?.aborted, false, "interval adoption must not cancel provider HTTP");
			merged = h.controller.refreshCurrent(h.ctx, merge === "replace-with-new-loaded" ? { loaded: h.loaded() } : {});
		} finally { release.resolve(); }
		await Promise.all([running, oldLoaded, merged]);
		assert.equal(h.snapshot().eligibility?.nextAutomaticCheckAt, START + 60_000);
		assert.equal(h.calls.length, count + (merge === "replace-with-new-loaded" ? 2 : 0));
		assert.equal(h.snapshot().state, "ready", "already-started provider data can still commit");
		// No stale-request suppression may prevent a later real disk observation.
		h.settings.refreshMinutes = 10; await h.save(); await h.refresh();
		assert.equal(h.snapshot().eligibility?.nextAutomaticCheckAt, START + 600_000);
	});
}

for (const boundary of ["url", "key"] as const) {
	for (const id of ["maxVisibleAccounts", "refreshMinutes", "claude", "showWidget", "managementUrl"]) {
		test(`actual ${boundary} change clears source facts despite changed ID ${id}`, { timeout: 5000 }, async (t) => {
			const h = await harness(t); await h.refresh(); h.wait = "provider"; await h.refresh(true);
			assert.match(h.render(), /left 80%/);
			if (boundary === "url") h.settings.managementUrl = SOURCE_B;
			else h.settings.managementKey = "synthetic-replacement";
			h.settings.maxVisibleAccounts = 5;
			await h.save();
			h.handler = (input) => String(input).endsWith("/auth-files")
				? Response.json({ files: [{ provider: "codex", auth_index: "a", label: "new-source" }] })
				: Response.json({ status_code: 401 });
			await h.controller.applySettings(h.ctx, h.settings, id);
			assert.equal(h.snapshot().eligibility?.manualAllowedAt, undefined, "old-source server instruction must not migrate");
			assert.ok(h.snapshot().accounts.every((account) => account.lastValidAt === undefined && !account.windows.length));
			assert.doesNotMatch(h.render(), /left 80%/);
			assert.equal(h.controller.lastRefresh("codex"), undefined);
		});
	}
}

for (const id of ["maxVisibleAccounts", "refreshMinutes", "managementUrl", "showWidget", "claude"]) {
	test(`cumulative provider changes apply before changed ID ${id} returns`, { timeout: 5000 }, async (t) => {
		const h = await harness(t); await h.refresh(); h.wait = "provider"; await h.refresh(true);
		h.settings.providers.codex = false; h.settings.maxVisibleAccounts = 5;
		await h.save(); await h.controller.applySettings(h.ctx, h.settings, id);
		assert.equal(h.snapshot().state, "disabled");
		assert.equal(h.controller.lastRefresh("codex"), undefined, "disabled account data is removed even for an incidental ID");
		const count = h.calls.length;
		h.settings.providers.codex = true;
		await h.save(); await h.controller.applySettings(h.ctx, h.settings, "maxVisibleAccounts");
		await h.refresh(true);
		assert.equal(h.calls.length, count, "same-source disable/re-enable retains its live provider wait");
		assert.deepEqual(h.snapshot().accounts, []);
		assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
	});
}

for (const scope of ["provider", "management"] as const) {
	test(`same-value Management URL submission preserves ${scope} wait and never forces HTTP`, { timeout: 5000 }, async (t) => {
		const h = await harness(t); await h.refresh(); h.wait = scope; await h.refresh(true);
		const before = h.snapshot(); const count = h.calls.length;
		await h.controller.applySettings(h.ctx, h.settings, "managementUrl");
		assert.equal(h.calls.length, count);
		assert.deepEqual(h.snapshot().accounts, before.accounts);
		assert.equal(h.snapshot().lastCompleteSuccessAt, before.lastCompleteSuccessAt);
		assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
		await h.refresh(true);
		assert.equal(h.calls.length, count);
	});
}

test("real SettingsList second save applies a cumulative source edit after its first save failed", { timeout: 5000 }, async (t) => {
	const h = await harness(t); await h.refresh(); h.wait = "provider"; await h.refresh(true);
	initTheme("dark");
	const ready = deferred<Component>(); const applied = deferred<void>();
	const renameEntered = deferred<void>(); const failRename = deferred<void>();
	const originalRename = fs.rename;
	let failed = false;
	t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
		if (!failed && String(args[1]) === h.paths.settingsPath) {
			failed = true; renameEntered.resolve(); await failRename.promise;
			throw Object.assign(new Error("synthetic atomic save failure"), { code: "EACCES" });
		}
		return originalRename(...args);
	});
	syncBuiltinESMExports();
	const changes: string[] = [];
	const ctx = { ...h.ctx, ui: { ...h.ctx.ui,
		custom: ((factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void) => Component) => new Promise<void>((resolve, reject) => {
			try { ready.resolve(factory({ requestRender() {} } as TUI, h.ctx.ui.theme, {} as KeybindingsManager, resolve)); }
			catch (error) { reject(error); }
		})) as ExtensionCommandContext["ui"]["custom"],
	} } as ExtensionCommandContext;
	const showing = showSettings(ctx, h.paths.settingsPath, h.paths.legacySettingsPath, async (settings, id) => {
		changes.push(id); await h.controller.applySettings(h.ctx, settings, id); applied.resolve();
	});
	const screen = await ready.promise;
	const input = (text: string) => { for (const character of text) screen.handleInput!(character); };
	try {
		input("management"); screen.handleInput!("\r");
		screen.handleInput!("\x01"); screen.handleInput!("\x0b");
		input(SOURCE_B); screen.handleInput!("\r");
		await renameEntered.promise;
		// Queue the second full snapshot before the first save fails. The real
		// SettingsList deliberately retains cumulative edits at this revision.
		screen.handleInput!("\x15"); input("visible"); screen.handleInput!("\r");
		h.handler = (url) => String(url).endsWith("/auth-files") ? Response.json({ files: [] }) : h.reply(url);
		failRename.resolve(); await applied.promise;
		assert.deepEqual(changes, ["maxVisibleAccounts"]);
		assert.match(h.notices.join("\n"), /Failed to save settings: synthetic atomic save failure/);
		const persisted = JSON.parse(await fs.readFile(h.paths.settingsPath, "utf8"));
		assert.equal(persisted.managementUrl, SOURCE_B);
		assert.equal(persisted.maxVisibleAccounts, 5);
		assert.deepEqual(h.snapshot().accounts, []);
		assert.equal(h.snapshot().eligibility?.manualAllowedAt, undefined);
		assert.doesNotMatch(h.render(), /left 80%/);
	} finally {
		failRename.resolve(); screen.handleInput!("\x1b"); screen.handleInput!("\x1b"); await showing;
	}
});
