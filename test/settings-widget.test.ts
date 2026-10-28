import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { initTheme, type ExtensionCommandContext, type ExtensionUIContext, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI } from "@earendil-works/pi-tui";
import { showSettings } from "../src/settings-ui.js";
import { loadSettings } from "../src/settings.js";
import type { Settings } from "../src/types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

// Only the host custom-screen boundary is supplied here. showSettings constructs
// the actual SettingsList; every change below enters through its keyboard path.
function settingsHost() {
	initTheme("dark");
	const ready = deferred<Component>();
	const notified = deferred<{ message: string; level: string | undefined }>();
	const tui = { requestRender() {} } as TUI;
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
	const ui: Pick<ExtensionUIContext, "custom" | "notify"> = {
		custom(factory) {
			return new Promise((resolve, reject) => {
				Promise.resolve(factory(tui, theme, {} as KeybindingsManager, resolve)).then(ready.resolve, (error) => {
					ready.reject(error);
					reject(error);
				});
			});
		},
		notify(message, level) { notified.resolve({ message, level }); },
	};
	const ctx = { mode: "tui", hasUI: true, ui } as ExtensionCommandContext;
	return { ctx, ready: ready.promise, notified: notified.promise };
}

function render(component: Component): string {
	return stripVTControlCharacters(component.render(120).join("\n"));
}

function widgetRow(component: Component): string {
	const text = render(component);
	const row = text.split("\n").find((line) => /Widget visibility\s+(enabled|disabled)/.test(line));
	assert.ok(row, `Missing widget setting in real SettingsList:\n${text}`);
	return row;
}

function filterWidget(component: Component): void {
	for (const character of "widget") component.handleInput!(character);
	assert.match(widgetRow(component), /enabled/);
	assert.doesNotMatch(render(component), /Visible accounts/);
}

test("real settings keyboard saves independent widget visibility, preserves unknown fields and toggles back", { timeout: 5000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-widget-ui-"));
	const path = join(dir, "settings.json");
	const legacy = join(dir, "old.json");
	const host = settingsHost();
	let applied = deferred<void>();
	const changes: { settings: Settings; id: string }[] = [];
	let screen: Component | undefined;
	let showing: Promise<void> | undefined;
	try {
		await writeFile(path, JSON.stringify({ future: { keep: [1, "yes"] }, providers: { codex: false, future: "preserved" } }));
		showing = showSettings(host.ctx, path, legacy, async (settings, id) => {
			changes.push({ settings, id });
			applied.resolve();
		});
		screen = await host.ready;
		filterWidget(screen);
		for (const expected of [false, true]) {
			applied = deferred<void>();
			screen.handleInput!("\r");
			assert.match(widgetRow(screen), expected ? /enabled/ : /disabled/);
			await applied.promise;
			const loaded = await loadSettings(path, legacy);
			assert.equal(loaded.settings.showWidget, expected);
			assert.equal(loaded.settings.providers.codex, false);
			assert.deepEqual(loaded.raw.future, { keep: [1, "yes"] });
			assert.equal((loaded.raw.providers as Record<string, unknown>).future, "preserved");
			assert.equal(changes.at(-1)?.id, "showWidget");
			assert.equal(changes.at(-1)?.settings.showWidget, expected);
			assert.equal(changes.at(-1)?.settings.providers.codex, false);
			assert.match(render(screen), new RegExp(`Widget visibility: ${expected ? "enabled" : "disabled"}`));
			assert.equal((await stat(path)).mode & 0o777, 0o600);
			assert.deepEqual(await readdir(dir), ["settings.json"]);
		}
		assert.equal(changes.length, 2);
		assert.equal(JSON.parse(await readFile(path, "utf8")).showWidget, true);
	} finally {
		// One Escape clears the real list's filter, the next closes the screen.
		screen?.handleInput?.("\x1b");
		screen?.handleInput?.("\x1b");
		await showing;
		await rm(dir, { recursive: true, force: true });
	}
});

test("real settings keyboard rolls widget visibility back after atomic rename fails", { timeout: 5000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-widget-ui-"));
	const path = join(dir, "settings.json");
	const host = settingsHost();
	const changes: Settings[] = [];
	let screen: Component | undefined;
	let showing: Promise<void> | undefined;
	try {
		await writeFile(path, JSON.stringify({ showWidget: true }));
		showing = showSettings(host.ctx, path, join(dir, "old.json"), async (settings) => { changes.push(settings); });
		screen = await host.ready;
		filterWidget(screen);
		// Replace only after load: writing the temp file succeeds but rename fails.
		await rm(path);
		await mkdir(path);
		screen.handleInput!("\r");
		assert.match(widgetRow(screen), /disabled/);
		const notification = await host.notified;
		assert.equal(notification.level, "error");
		assert.match(notification.message, /^Failed to save settings:/);
		assert.match(widgetRow(screen), /enabled/);
		assert.match(render(screen), /Widget visibility: enabled/);
		assert.deepEqual(changes, []);
		assert.equal((await stat(path)).isDirectory(), true);
		assert.deepEqual(await readdir(dir), ["settings.json"]);
	} finally {
		screen?.handleInput?.("\x1b");
		screen?.handleInput?.("\x1b");
		await showing;
		await rm(dir, { recursive: true, force: true });
	}
});

test("settings URL editor rejects unsafe URL, permits correction, and can return to automatic", { timeout: 5000 }, async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-url-ui-"));
	const path = join(dir, "settings.json");
	const legacy = join(dir, "old.json");
	const host = settingsHost();
	let applied = deferred<void>();
	let screen: Component | undefined;
	let showing: Promise<void> | undefined;
	try {
		await writeFile(path, JSON.stringify({ managementUrl: "https://hidden-user:hidden-pass@proxy.example", managementKey: "saved-password" }));
		const before = await readFile(path, "utf8");
		showing = showSettings(host.ctx, path, legacy, async () => { applied.resolve(); });
		screen = await host.ready;
		assert.doesNotMatch(render(screen), /hidden-user|hidden-pass|saved-password/);
		for (const character of "management") screen.handleInput!(character);
		screen.handleInput!("\r");
		assert.doesNotMatch(render(screen), /hidden-user|hidden-pass/);
		screen.handleInput!("ftp://proxy.example");
		screen.handleInput!("\r");
		assert.match((await host.notified).message, /valid HTTP\(S\) URL without embedded credentials/);
		assert.equal(await readFile(path, "utf8"), before);
		screen.handleInput!("\x15"); // ctrl-u clears invalid entry for correction
		screen.handleInput!("http://[::1]:8317/prefix/v1/");
		screen.handleInput!("\r");
		await applied.promise;
		assert.equal((await loadSettings(path, legacy)).settings.managementUrl, "http://[::1]:8317/prefix");
		applied = deferred<void>();
		screen.handleInput!("\r");
		screen.handleInput!("\x05"); // ctrl-e: prefilled Input starts at column zero
		screen.handleInput!("\x15");
		screen.handleInput!("\r");
		await applied.promise;
		assert.equal((await loadSettings(path, legacy)).settings.managementUrl, "");
		assert.equal((await loadSettings(path, legacy)).settings.managementKey, "saved-password");
		screen.handleInput!("\x1b");
		await showing;
	} finally {
		screen?.handleInput?.("\x1b");
		await showing;
		await rm(dir, { recursive: true, force: true });
	}
});
