import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
	parseClaude,
	parseCodex,
	parseDeepSeek,
	parseGrok,
	parseKimi,
	toNumber,
} from "./parsers.js";
import type { AccountUsage, Config, ProviderName } from "./types.js";

type OAuthProviderName = Exclude<ProviderName, "deepseek">;

type AuthFile = {
	type?: string;
	email?: string;
	access_token?: string;
	account_id?: string;
	disabled?: boolean;
};

const OAUTH_PROVIDERS = new Set<OAuthProviderName>([
	"claude",
	"codex",
	"grok",
	"kimi",
]);
const USAGE_URLS = {
	claude: "https://api.anthropic.com/api/oauth/usage",
	codex: "https://chatgpt.com/backend-api/wham/usage",
	deepseek: "https://api.deepseek.com/user/balance",
	grok: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	kimi: "https://api.kimi.com/coding/v1/usages",
} as const;

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return resolve(path);
}

function yamlScalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith('"')) {
		try {
			return JSON.parse(trimmed) as string;
		} catch {
			return "";
		}
	}
	if (trimmed.startsWith("'")) {
		const end = trimmed.lastIndexOf("'");
		return end > 0 ? trimmed.slice(1, end).replace(/''/g, "'") : "";
	}
	return trimmed.replace(/\s+#.*$/, "").trim();
}

function yamlField(text: string, field: string): string | undefined {
	const match = text.match(new RegExp(`^(?:-\\s*)?${field}:\\s*(.*)$`, "i"));
	return match ? yamlScalar(match[1] ?? "") : undefined;
}

/** Extract only API keys explicitly configured for the official DeepSeek host. */
export function parseDeepSeekApiKeys(yaml: string): string[] {
	const lines = yaml.split(/\r?\n/).map((raw) => ({
		indent: raw.length - raw.trimStart().length,
		text: raw.trim(),
	}));
	const sectionIndex = lines.findIndex(
		(line) => line.text.toLowerCase() === "openai-compatibility:",
	);
	if (sectionIndex < 0) return [];
	const sectionIndent = lines[sectionIndex]?.indent ?? 0;
	let sectionEnd = lines.length;
	for (let index = sectionIndex + 1; index < lines.length; index++) {
		const line = lines[index];
		if (line?.text && line.indent <= sectionIndent) {
			sectionEnd = index;
			break;
		}
	}

	const firstProvider = lines.findIndex(
		(line, index) =>
			index > sectionIndex &&
			index < sectionEnd &&
			line.indent > sectionIndent &&
			/^-\s*name:/i.test(line.text),
	);
	if (firstProvider < 0) return [];
	const providerIndent = lines[firstProvider]?.indent ?? sectionIndent + 2;
	const providers: number[] = [];
	for (let index = firstProvider; index < sectionEnd; index++) {
		const line = lines[index];
		if (
			line?.indent === providerIndent &&
			/^-\s*name:/i.test(line.text)
		) {
			providers.push(index);
		}
	}

	const keys: string[] = [];
	for (let providerIndex = 0; providerIndex < providers.length; providerIndex++) {
		const start = providers[providerIndex] ?? 0;
		const end = providers[providerIndex + 1] ?? sectionEnd;
		let baseUrl = "";
		let disabled = false;
		let apiKeysIndent: number | undefined;
		const providerKeys: string[] = [];
		const directIndent = Math.min(
			...lines
				.slice(start + 1, end)
				.filter((line) => line.text && line.indent > providerIndent)
				.map((line) => line.indent),
		);
		for (let index = start + 1; index < end; index++) {
			const line = lines[index];
			if (!line) continue;
			if (line.indent === directIndent) {
				baseUrl ||= yamlField(line.text, "base-url") ?? "";
				disabled ||= yamlField(line.text, "disabled")?.toLowerCase() === "true";
			}
			if (
				line.indent === directIndent &&
				line.text.toLowerCase() === "api-key-entries:"
			) {
				apiKeysIndent = line.indent;
				continue;
			}
			if (apiKeysIndent === undefined) continue;
			if (line.indent <= apiKeysIndent) {
				apiKeysIndent = undefined;
				continue;
			}
			const key = yamlField(line.text, "api-key");
			if (key) providerKeys.push(key);
		}
		try {
			if (
				!disabled &&
				new URL(baseUrl).hostname.toLowerCase() === "api.deepseek.com"
			) {
				keys.push(...providerKeys);
			}
		} catch {
			// Ignore malformed and non-official provider URLs.
		}
	}
	return [...new Set(keys)];
}

function providerName(type?: string): OAuthProviderName | undefined {
	const provider = type === "xai" ? "grok" : type;
	return OAUTH_PROVIDERS.has(provider as OAuthProviderName)
		? (provider as OAuthProviderName)
		: undefined;
}

/** Map the active Pi model to the matching CLIProxyAPI account provider. */
export function providerForModel(
	provider: string,
	modelId: string,
): ProviderName | undefined {
	const value = `${provider}/${modelId}`.toLowerCase();
	if (/(^|[\/_-])claude(?:[.\/_-]|$)/.test(value)) return "claude";
	if (/(^|[\/_-])deepseek(?:[.\/_-]|$)/.test(value)) return "deepseek";
	if (/(^|[\/_-])(?:gpt|codex)(?:[.\/_-]|$)/.test(value)) return "codex";
	if (/(^|[\/_-])(?:kimi|moonshot)(?:[.\/_-]|$)/.test(value)) return "kimi";
	if (/(^|[\/_-])(?:grok|xai)(?:[.\/_-]|$)/.test(value)) return "grok";
	return undefined;
}

export function accountsForModel(
	items: AccountUsage[],
	provider: string,
	modelId: string,
): AccountUsage[] {
	const accountProvider = providerForModel(provider, modelId);
	return accountProvider
		? items.filter((item) => item.provider === accountProvider)
		: [];
}

async function request(
	url: string,
	token: string,
	headers: Record<string, string> = {},
): Promise<{ body: unknown; headers: Headers }> {
	const response = await fetch(url, {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
			"User-Agent": "pi-cliproxy-usage",
			...headers,
		},
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return { body: await response.json(), headers: response.headers };
}

async function fetchUsage(
	provider: OAuthProviderName,
	auth: AuthFile,
	file: string,
): Promise<AccountUsage> {
	const label =
		auth.email ||
		basename(file, ".json").replace(/^(claude|codex|xai|kimi)-/, "");
	try {
		if (!auth.access_token) throw new Error("missing access_token");
		if (provider === "claude") {
			const { body } = await request(USAGE_URLS.claude, auth.access_token, {
				"anthropic-beta": "oauth-2025-04-20",
				"Content-Type": "application/json",
			});
			return { provider, label, ...parseClaude(body) };
		}
		if (provider === "codex") {
			const headers: Record<string, string> = {};
			if (auth.account_id) headers["ChatGPT-Account-Id"] = auth.account_id;
			const response = await request(
				USAGE_URLS.codex,
				auth.access_token,
				headers,
			);
			const parsed = parseCodex(response.body);
			if (!parsed.windows.length) {
				const used = toNumber(
					response.headers.get("x-codex-primary-used-percent"),
				);
				if (used !== undefined) {
					parsed.windows.push({ label: "limit", used });
				}
			}
			return { provider, label, ...parsed };
		}
		if (provider === "kimi") {
			const { body } = await request(USAGE_URLS.kimi, auth.access_token);
			return { provider, label, ...parseKimi(body) };
		}
		const { body } = await request(USAGE_URLS.grok, auth.access_token, {
			"X-XAI-Token-Auth": "xai-grok-cli",
		});
		return { provider, label, ...parseGrok(body) };
	} catch (error) {
		return {
			provider,
			label,
			windows: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function fetchDeepSeekBalance(
	apiKey: string,
	label: string,
): Promise<AccountUsage> {
	try {
		const { body } = await request(USAGE_URLS.deepseek, apiKey);
		const parsed = parseDeepSeek(body);
		if (!parsed.balance?.amounts.length) throw new Error("missing balance");
		return { provider: "deepseek", label, ...parsed };
	} catch (error) {
		return {
			provider: "deepseek",
			label,
			windows: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function readDeepSeekAccounts(config: Config): Promise<AccountUsage[]> {
	if (!config.providers.deepseek) return [];
	try {
		const yaml = await readFile(expandHome(config.cliproxyConfigPath), "utf8");
		const keys = parseDeepSeekApiKeys(yaml);
		return Promise.all(
			keys.map((key, index) =>
				fetchDeepSeekBalance(key, keys.length === 1 ? "" : `key ${index + 1}`),
			),
		);
	} catch {
		return [];
	}
}

async function readAccount(
	dir: string,
	name: string,
	config: Config,
): Promise<AccountUsage | undefined> {
	try {
		const file = join(dir, name);
		const auth = JSON.parse(await readFile(file, "utf8")) as AuthFile;
		const provider = providerName(auth.type);
		if (!provider || auth.disabled || !config.providers[provider])
			return undefined;
		return fetchUsage(provider, auth, file);
	} catch {
		return undefined;
	}
}

async function readOAuthAccounts(config: Config): Promise<AccountUsage[]> {
	const dir = expandHome(config.accountsDir);
	try {
		const names = (await readdir(dir)).filter((name) =>
			name.toLowerCase().endsWith(".json"),
		);
		const accounts = await Promise.all(
			names.map((name) => readAccount(dir, name, config)),
		);
		return accounts.filter(Boolean) as AccountUsage[];
	} catch {
		return [];
	}
}

export async function readAccounts(config: Config): Promise<AccountUsage[]> {
	const [oauth, deepseek] = await Promise.all([
		readOAuthAccounts(config),
		readDeepSeekAccounts(config),
	]);
	return [...oauth, ...deepseek];
}
