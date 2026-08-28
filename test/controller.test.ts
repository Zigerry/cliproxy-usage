import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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

test("mixed refresh updates successful accounts and keeps failed account cache", async () => {
	const originalFetch = globalThis.fetch;
	let phase: "initial" | "partial" = "initial";
	let widget: unknown;
	let details: string[] = [];
	let customOptions: unknown;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		model: { provider: "cliproxyapi", id: "gpt-5" },
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			setWidget: (_id: string, content: unknown) => {
				widget = content;
			},
			notify() {},
			custom: async (
				factory: (...args: any[]) => any,
				options: unknown,
			) => {
				customOptions = options;
				const tui = {
					terminal: { rows: 12 },
					requestRender() {},
				};
				const component = await factory(tui, theme, {}, () => {});
				details = component.render(80);
				component.handleInput?.("\x1b");
				component.dispose?.();
			},
		},
	} as unknown as ExtensionCommandContext;
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
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			if (url.endsWith("/auth-files")) {
				return new Response(
					JSON.stringify({
						files: [
							{
								auth_index: "codex-1",
								provider: "codex",
								email: "work@example.com",
							},
							{
								auth_index: "codex-2",
								provider: "codex",
								email: "personal@example.com",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			const request = JSON.parse(String(init?.body)) as {
				auth_index: string;
			};
			if (phase === "partial" && request.auth_index === "codex-2") {
				return new Response(JSON.stringify({ status_code: 503 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			const used =
				request.auth_index === "codex-1"
					? phase === "initial"
						? 25
						: 35
					: 40;
			return new Response(
				JSON.stringify({
					status_code: 200,
					body: JSON.stringify({
						rate_limit: {
							primary_window: {
								used_percent: used,
								limit_window_seconds: 604800,
							},
						},
					}),
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const renderWidget = () => {
			const factory = widget as (
				tui: unknown,
				widgetTheme: {
					fg: (color: string, text: string) => string;
				},
			) => { render(width: number): string[] };
			return factory(undefined, theme).render(120).join("\n");
		};

		await controller.refreshCurrent(ctx, { force: true, loaded });
		assert.match(renderWidget(), /work@example.com.*left 75%/);
		assert.match(renderWidget(), /personal@example.*left 60%/);

		phase = "partial";
		await controller.refreshCurrent(ctx, { force: true, loaded });
		assert.match(renderWidget(), /work@example.com.*left 65%/);
		assert.match(renderWidget(), /personal@example.*left 60%/);

		await controller.showDetails(ctx);
		assert.deepEqual(customOptions, {
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 80,
				maxHeight: "100%",
			},
		});
		assert.ok(details.length <= 12);
		assert.match(details[0] ?? "", /CLIProxyAPI Usage/);
		assert.ok(
			details.some((line) =>
				line.includes(
					"Refresh failed: personal@example.com: HTTP 503 · showing cached data",
				),
			),
		);
		assert.ok(
			details.some((line) => line.includes("personal@example.com")),
		);
		assert.ok(details.some((line) => line.includes("left 60%")));
	} finally {
		controller.shutdown(ctx);
		globalThis.fetch = originalFetch;
	}
});

test("failed refresh keeps cached usage and exposes the error in details", async () => {
	const originalFetch = globalThis.fetch;
	let phase: "success" | "failure" = "success";
	let requests = 0;
	let widget: unknown;
	let details: string[] = [];
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		model: { provider: "cliproxyapi", id: "gpt-5" },
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			setWidget: (_id: string, content: unknown) => {
				widget = content;
			},
			notify() {},
			custom: async (factory: (...args: any[]) => any) => {
				const tui = {
					terminal: { rows: 24 },
					requestRender() {},
				};
				const component = await factory(tui, theme, {}, () => {});
				details = component.render(80);
				component.handleInput?.("\x1b");
				component.dispose?.();
			},
		},
	} as unknown as ExtensionCommandContext;
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
		globalThis.fetch = async (input) => {
			requests++;
			const url = String(input);
			if (phase === "failure") return new Response("", { status: 503 });
			if (url.endsWith("/auth-files")) {
				return new Response(
					JSON.stringify({
						files: [
							{
								auth_index: "codex-1",
								provider: "codex",
								email: "work@example.com",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					status_code: 200,
					body: JSON.stringify({
						rate_limit: {
							primary_window: {
								used_percent: 25,
								limit_window_seconds: 604800,
							},
						},
					}),
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		await controller.refreshCurrent(ctx, { force: true, loaded });
		const renderWidget = () => {
			const factory = widget as (
				tui: unknown,
				widgetTheme: {
					fg: (color: string, text: string) => string;
				},
			) => { render(width: number): string[] };
			return factory(undefined, theme).render(100).join("\n");
		};
		assert.match(renderWidget(), /work@example.com.*left 75%/);

		phase = "failure";
		await controller.refreshCurrent(ctx, { force: true, loaded });
		assert.match(renderWidget(), /work@example.com.*left 75%/);

		const beforeDetails = requests;
		await controller.showDetails(ctx);
		assert.equal(requests, beforeDetails);
		assert.ok(
			details.some((line) =>
				line.includes("Refresh failed: management HTTP 503 · showing cached data"),
			),
		);
		assert.ok(details.some((line) => line.includes("work@example.com")));
		assert.ok(details.some((line) => line.includes("left 75%")));
	} finally {
		controller.shutdown(ctx);
		globalThis.fetch = originalFetch;
	}
});
