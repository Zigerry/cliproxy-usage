import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

test("settings UI and setup/login/logout commands reject invalid configuration before prompts", async (t) => {
	// node:test runs this file in an isolated process. Import the extension only
	// after redirecting public SDK configuration paths away from the real user.
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-command-diagnostics-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const previous = process.env.PI_CODING_AGENT_DIR;
	let activate: typeof import("../index.js")["default"];
	try {
		process.env.PI_CODING_AGENT_DIR = dir;
		({ default: activate } = await import("../index.js"));
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	}
	const path = join(dir, "pi-cliproxy-usage.json");
	const marker = "SYNTHETIC_MARKER";
	await writeFile(path, marker);
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	activate({
		on() {}, // Capture no lifecycle activity; in particular never start a session.
		registerCommand(name: string, options: NonNullable<typeof command>) {
			assert.equal(name, "cliproxy-usage");
			command = options;
		},
	} as unknown as ExtensionAPI);
	assert.ok(command);
	const handler = command.handler;
	let prompts = 0;
	let requests = 0;
	const notices: { message: string; level: string }[] = [];
	const unexpectedPrompt = () => { prompts++; throw new Error("unexpected prompt"); };
	const ctx = {
		mode: "tui", hasUI: true,
		ui: {
			notify(message: string, level: string) { notices.push({ message, level }); },
			custom: unexpectedPrompt, confirm: unexpectedPrompt, input: unexpectedPrompt,
		},
	} as unknown as ExtensionCommandContext;
	t.mock.method(globalThis, "fetch", async () => { requests++; throw new Error("unexpected request"); });
	const { showSettings } = await import("../src/settings-ui.js");
	await t.test("showSettings", async () => {
		await showSettings(ctx, path, join(dir, "legacy.json"), async () => assert.fail("unexpected settings change"));
		assert.deepEqual(notices.splice(0), [{
			message: "Cannot edit invalid settings: Invalid settings file; expected a JSON object.", level: "error",
		}]);
	});
	for (const action of ["setup", "login", "logout", "settings"]) {
		await t.test(action, async () => {
			await handler(action, ctx);
			const prefix = action === "settings" ? "edit" : "update";
			assert.deepEqual(notices.splice(0), [{
				message: `Cannot ${prefix} invalid settings: Invalid settings file; expected a JSON object.`, level: "error",
			}]);
			assert.equal(await readFile(path, "utf8"), marker);
		});
	}
	assert.equal(prompts, 0);
	assert.equal(requests, 0);
});

test("invalid settings diagnostics are stable across parser inputs and shapes", async (t) => {
	const { loadSettings, DEFAULT_SETTINGS } = await import("../src/settings.js");
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-invalid-settings-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "settings.json");
	for (const text of ["SYNTHETIC_MARKER", '{"managementKey": SYNTHETIC_MARKER}', "{", "[]", "null"]) {
		await writeFile(path, text);
		const loaded = await loadSettings(path, join(dir, "legacy.json"));
		assert.equal(loaded.writable, false);
		assert.deepEqual(loaded.settings, DEFAULT_SETTINGS);
		assert.deepEqual(loaded.raw, {});
		assert.deepEqual(loaded.warnings, ["Invalid settings file; expected a JSON object."]);
		assert.equal(await readFile(path, "utf8"), text);
	}
});
