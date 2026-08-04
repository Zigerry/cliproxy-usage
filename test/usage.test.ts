import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountsForModel,
	parseDeepSeekApiKeys,
	providerForModel,
	readAccounts,
} from "../src/usage.js";
import type { AccountUsage, Config } from "../src/types.js";

const config = (
	accountsDir: string,
	cliproxyConfigPath = join(tmpdir(), "missing-cliproxy-config.yaml"),
): Config => ({
	accountsDir,
	cliproxyConfigPath,
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

test("parseDeepSeekApiKeys accepts only official DeepSeek providers", () => {
	assert.deepEqual(
		parseDeepSeekApiKeys(`
openai-compatibility:
  - name: DeepSeek
    base-url: https://api.deepseek.com/
    api-key-entries:
      - api-key: sk-one
      - api-key: "sk-two"
      - api-key: sk-one
    models:
      - name: deepseek-chat
  - name: disabled-deepseek
    disabled: true
    base-url: https://api.deepseek.com/
    api-key-entries:
      - api-key: disabled-key
  - name: third-party
    base-url: https://example.com/v1
    api-key-entries:
      - api-key: do-not-use
  - name: mimo
    base-url: https://api.xiaomimimo.com/v1
    api-key-entries:
      - api-key: mimo-key
`),
		["sk-one", "sk-two"],
	);
});

test("readAccounts loads DeepSeek balance from CLIProxyAPI config", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
	const originalFetch = globalThis.fetch;
	let requestedUrl = "";
	let authorization = "";
	try {
		const configPath = join(dir, "config.yaml");
		await writeFile(
			configPath,
			`openai-compatibility:\n  - name: DeepSeek\n    base-url: https://api.deepseek.com/\n    api-key-entries:\n      - api-key: test-secret\n`,
		);
		globalThis.fetch = async (input, init) => {
			requestedUrl = String(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return new Response(
				JSON.stringify({
					is_available: true,
					balance_infos: [{ currency: "CNY", total_balance: "42.50" }],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};
		assert.deepEqual(await readAccounts(config(join(dir, "accounts"), configPath)), [
			{
				provider: "deepseek",
				label: "",
				windows: [],
				balance: {
					available: true,
					amounts: [{ currency: "CNY", amount: 42.5 }],
				},
			},
		]);
		assert.equal(requestedUrl, "https://api.deepseek.com/user/balance");
		assert.equal(authorization, "Bearer test-secret");
	} finally {
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAccounts returns empty for missing directory", async () => {
	assert.deepEqual(
		await readAccounts(config(join(tmpdir(), "missing-cliproxy-dir"))),
		[],
	);
});

test("readAccounts skips malformed, unknown, disabled, and disabled-provider files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
	try {
		await Promise.all([
			writeFile(join(dir, "broken.json"), "{"),
			writeFile(
				join(dir, "unknown.json"),
				JSON.stringify({ type: "gemini", access_token: "x" }),
			),
			writeFile(
				join(dir, "disabled.json"),
				JSON.stringify({ type: "claude", access_token: "x", disabled: true }),
			),
			writeFile(
				join(dir, "ignored.txt"),
				JSON.stringify({ type: "claude", access_token: "x" }),
			),
		]);
		const value = config(dir);
		value.providers.claude = false;
		await writeFile(
			join(dir, "provider-off.json"),
			JSON.stringify({ type: "claude", access_token: "x" }),
		);
		assert.deepEqual(await readAccounts(value), []);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("readAccounts reports missing token without making a request", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-cliproxy-usage-"));
	try {
		await writeFile(
			join(dir, "xai-local.json"),
			JSON.stringify({ type: "xai", email: "me@example.com" }),
		);
		assert.deepEqual(await readAccounts(config(dir)), [
			{
				provider: "grok",
				label: "me@example.com",
				windows: [],
				error: "missing access_token",
			},
		]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("providerForModel maps CLIProxyAPI model ids to OAuth account types", () => {
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
