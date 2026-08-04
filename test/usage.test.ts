import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountsForModel,
	providerForModel,
	readAccounts,
	resolveManagementSource,
	validateManagementAccess,
} from "../src/usage.js";
import type { AccountUsage, Config } from "../src/types.js";

const config = (): Config => ({
	managementUrl: "",
	managementKey: "",
	refreshMinutes: 5,
	maxVisibleAccounts: 4,
	providers: {
		claude: true,
		codex: true,
		deepseek: true,
		grok: true,
		kimi: true,
	},
});

test("resolveManagementSource reuses provider base URL by default", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
	try {
		const providerConfigPath = join(dir, "cliproxyapi.json");
		await writeFile(
			providerConfigPath,
			JSON.stringify({ baseUrl: "http://127.0.0.1:9274/" }),
		);
		assert.deepEqual(
			await resolveManagementSource(config(), providerConfigPath),
			{
				providerBaseUrl: "http://127.0.0.1:9274",
				managementUrl: "http://127.0.0.1:9274",
				managementKeyConfigured: false,
			},
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("resolveManagementSource accepts a private management URL override", async () => {
	const value = config();
	value.managementUrl = "http://127.0.0.1:9274/v0/management/";
	value.managementKey = "secret";
	assert.deepEqual(await resolveManagementSource(value), {
		providerBaseUrl: undefined,
		managementUrl: "http://127.0.0.1:9274",
		managementKeyConfigured: true,
	});
});

test("resolveManagementSource reports malformed overrides", async () => {
	const value = config();
	value.managementUrl = "not a URL";
	assert.deepEqual(await resolveManagementSource(value), {
		providerBaseUrl: undefined,
		managementKeyConfigured: false,
		error: "invalid managementUrl",
	});
});

test("validateManagementAccess checks auth-files with the submitted password", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
	const originalFetch = globalThis.fetch;
	try {
		const providerConfigPath = join(dir, "cliproxyapi.json");
		await writeFile(
			providerConfigPath,
			JSON.stringify({ baseUrl: "https://proxy.example.com" }),
		);
		let authorization = "";
		globalThis.fetch = async (_input, init) => {
			authorization =
				new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(JSON.stringify({ files: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};
		assert.equal(
			await validateManagementAccess(
				config(),
				providerConfigPath,
				"submitted-secret",
			),
			"https://proxy.example.com",
		);
		assert.equal(authorization, "Bearer submitted-secret");
	} finally {
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAccounts queries provider quota through the remote Management API", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
	const originalFetch = globalThis.fetch;
	try {
		const providerConfigPath = join(dir, "cliproxyapi.json");
		await writeFile(
			providerConfigPath,
			JSON.stringify({ baseUrl: "https://proxy.example.com" }),
		);
		const value = config();
		value.managementKey = "management-secret";
		const requests: Array<{ url: string; authorization: string; body?: unknown }> = [];
		globalThis.fetch = async (input, init) => {
			const url = String(input);
			const authorization =
				new Headers(init?.headers).get("Authorization") ?? "";
			const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			requests.push({ url, authorization, body });
			if (url.endsWith("/v0/management/auth-files")) {
				return new Response(
					JSON.stringify({
						files: [
							{
								auth_index: "codex-1",
								name: "codex-user.json",
								provider: "codex",
								email: "user@example.com",
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(
				JSON.stringify({
					status_code: 200,
					header: { "Content-Type": ["application/json"] },
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

		assert.deepEqual(
			await readAccounts(value, { providerConfigPath }),
			[
				{
					provider: "codex",
					label: "user@example.com",
					windows: [{ label: "7d", used: 25, resetsAt: undefined }],
				},
			],
		);
		assert.equal(requests.length, 2);
		assert.equal(requests[0]?.authorization, "Bearer management-secret");
		assert.equal(requests[1]?.authorization, "Bearer management-secret");
		assert.deepEqual(requests[1]?.body, {
			auth_index: "codex-1",
			method: "GET",
			url: "https://chatgpt.com/backend-api/wham/usage",
			header: {
				Authorization: "Bearer $TOKEN$",
				Accept: "application/json",
				"User-Agent": "pi-cliproxy-usage",
			},
		});
	} finally {
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAccounts reports setup instructions when the management key is missing", async () => {
	const value = config();
	value.managementUrl = "https://proxy.example.com";
	const items = await readAccounts(value);
	assert.deepEqual(accountsForModel(items, "cliproxyapi", "gpt-5"), [
		{
			provider: "codex",
			label: "remote",
			windows: [],
			error: "Management key is not configured; run /cliproxy-usage setup",
		},
	]);
});

test("readAccounts reports missing provider and management URLs", async () => {
	const value = config();
	value.managementKey = "secret";
	const items = await readAccounts(value);
	assert.equal(
		accountsForModel(items, "cliproxyapi", "gpt-5")[0]?.error,
		"CLIProxyAPI base URL not found; configure the provider or managementUrl",
	);
});

test("readAccounts signals rejected management credentials", async () => {
	const originalFetch = globalThis.fetch;
	let rejected = false;
	try {
		const value = config();
		value.managementUrl = "https://proxy.example.com";
		value.managementKey = "wrong";
		globalThis.fetch = async () => new Response("", { status: 401 });
		const items = await readAccounts(value, {
			onManagementAuthFailure: () => {
				rejected = true;
			},
		});
		assert.equal(rejected, true);
		assert.equal(
			accountsForModel(items, "cliproxyapi", "gpt-5")[0]?.error,
			"management authentication failed (HTTP 401); run /cliproxy-usage setup",
		);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("readAccounts skips disabled, unsupported, and disabled-provider records", async () => {
	const originalFetch = globalThis.fetch;
	try {
		const value = config();
		value.managementUrl = "https://proxy.example.com";
		value.managementKey = "secret";
		value.providers.claude = false;
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					files: [
						{ auth_index: "1", provider: "gemini", name: "gemini.json" },
						{
							auth_index: "2",
							provider: "codex",
							name: "codex.json",
							disabled: true,
						},
						{ auth_index: "3", provider: "claude", name: "claude.json" },
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		assert.deepEqual(await readAccounts(value), []);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("providerForModel maps CLIProxyAPI model ids to account types", () => {
	assert.equal(providerForModel("cliproxyapi", "gpt-5.6-sol"), "codex");
	assert.equal(providerForModel("cliproxyapi", "gpt-5.3-codex-spark"), "codex");
	assert.equal(providerForModel("cliproxyapi", "kimi-k2.7-code"), "kimi");
	assert.equal(providerForModel("anthropic", "claude-opus-4-6"), "claude");
	assert.equal(providerForModel("xai", "grok-4"), "grok");
	assert.equal(
		providerForModel("cliproxyapi", "deepseek-v4-pro"),
		"deepseek",
	);
});

test("accountsForModel shows only accounts matching the active model", () => {
	const items: AccountUsage[] = [
		{ provider: "codex", label: "gpt", windows: [] },
		{ provider: "deepseek", label: "deepseek", windows: [] },
		{ provider: "kimi", label: "kimi", windows: [] },
		{ provider: "claude", label: "claude", windows: [] },
	];
	assert.deepEqual(
		accountsForModel(items, "cliproxyapi", "gpt-5.6-sol").map(
			(item) => item.label,
		),
		["gpt"],
	);
	assert.deepEqual(
		accountsForModel(items, "cliproxyapi", "kimi-k3").map(
			(item) => item.label,
		),
		["kimi"],
	);
	assert.deepEqual(
		accountsForModel(items, "cliproxyapi", "deepseek-v4-flash").map(
			(item) => item.label,
		),
		["deepseek"],
	);
	assert.deepEqual(
		accountsForModel(items, "cliproxyapi", "mimo-v2.5-pro"),
		[],
	);
});
