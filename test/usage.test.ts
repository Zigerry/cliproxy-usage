import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountsForModel,
	providerForModel,
	readAccounts,
} from "../src/usage.js";
import type { AccountUsage, Config } from "../src/types.js";

const config = (accountsDir: string): Config => ({
	accountsDir,
	refreshMinutes: 5,
	maxVisibleAccounts: 4,
	providers: { claude: true, codex: true, grok: true, kimi: true },
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
	assert.equal(providerForModel("cliproxyapi", "deepseek-v4-pro"), undefined);
});

test("accountsForModel shows only accounts matching the active model", () => {
	const items: AccountUsage[] = [
		{ provider: "codex", label: "gpt", windows: [] },
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
		accountsForModel(items, "cliproxyapi", "mimo-v2.5-pro"),
		[],
	);
});
