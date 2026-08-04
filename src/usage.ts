import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseClaude, parseCodex, parseGrok, parseKimi, toNumber } from "./parsers.js";
import type { AccountUsage, Config, ProviderName } from "./types.js";

type AuthFile = {
	type?: string;
	email?: string;
	access_token?: string;
	account_id?: string;
	disabled?: boolean;
};

const PROVIDERS = new Set<ProviderName>(["claude", "codex", "grok", "kimi"]);
const USAGE_URLS = {
	claude: "https://api.anthropic.com/api/oauth/usage",
	codex: "https://chatgpt.com/backend-api/wham/usage",
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

function providerName(type?: string): ProviderName | undefined {
	const provider = type === "xai" ? "grok" : type;
	return PROVIDERS.has(provider as ProviderName)
		? (provider as ProviderName)
		: undefined;
}

/** Map the active Pi model to the matching CLIProxyAPI OAuth account type. */
export function providerForModel(
	provider: string,
	modelId: string,
): ProviderName | undefined {
	const value = `${provider}/${modelId}`.toLowerCase();
	if (/(^|[\/_-])claude(?:[.\/_-]|$)/.test(value)) return "claude";
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
	provider: ProviderName,
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

export async function readAccounts(config: Config): Promise<AccountUsage[]> {
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
