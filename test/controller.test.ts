import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";

test("startup refresh does not block and a manual refresh is not dropped", async () => {
	const originalFetch = globalThis.fetch;
	let releaseFirst: (() => void) | undefined;
	const firstResponse = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});
	let requests = 0;
	const notifications: string[] = [];
	let widget: unknown;
	const ctx = {
		model: { provider: "cliproxyapi", id: "gpt-5" },
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			setWidget: (_id: string, content: unknown) => {
				widget = content;
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.managementUrl = "https://proxy.example.com";
	settings.managementKey = "secret";
	const loaded: LoadedSettings = {
		settings,
		raw: {},
		path: "/tmp/settings.json",
		warnings: [],
		writable: true,
	};
	const controller = new UsageController({
		settingsPath: "/missing/settings.json",
		legacySettingsPath: "/missing/legacy.json",
		providerConfigPath: "/missing/provider.json",
	});

	try {
		globalThis.fetch = async () => {
			requests++;
			if (requests === 1) await firstResponse;
			return new Response(JSON.stringify({ files: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		controller.start(ctx, loaded);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(requests, 1);

		const manual = controller.refreshCurrent(ctx, {
			notify: true,
			force: true,
			loaded,
		});
		releaseFirst?.();
		await manual;

		assert.equal(requests, 2);
		assert.ok(
			notifications.includes("No Codex CLIProxyAPI accounts found."),
		);
		assert.equal(widget, undefined);
	} finally {
		controller.shutdown(ctx);
		globalThis.fetch = originalFetch;
	}
});
