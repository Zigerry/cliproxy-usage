import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
	parseClaude,
	parseCodex,
	parseDeepSeek,
	parseGrok,
	parseKimi,
	toNumber,
} from "./parsers.js";
import type { AccountUsage, Config, ProviderName } from "./types.js";

type RemoteAuthFile = {
	auth_index?: string;
	name?: string;
	provider?: string;
	label?: string;
	email?: string;
	account_type?: string;
	account_id?: string;
	disabled?: boolean;
	unavailable?: boolean;
	status?: string;
	status_message?: string;
};

type OpenAICompatibilityKey = {
	"auth-index"?: string;
};

type OpenAICompatibilityProvider = {
	name?: string;
	disabled?: boolean;
	"base-url"?: string;
	"auth-index"?: string;
	"api-key-entries"?: OpenAICompatibilityKey[];
};

type UsageResponse = { body: unknown; headers: Headers };

type RemoteApiCallResponse = {
	status_code?: number;
	header?: Record<string, string | string[]>;
	body?: unknown;
};

export type ManagementSource = {
	providerBaseUrl?: string;
	managementUrl?: string;
	managementKeyConfigured: boolean;
	error?: string;
};

export type ReadAccountsOptions = {
	providerConfigPath?: string;
	onManagementAuthFailure?: () => void;
};

const USAGE_URLS = {
	claude: "https://api.anthropic.com/api/oauth/usage",
	codex: "https://chatgpt.com/backend-api/wham/usage",
	deepseek: "https://api.deepseek.com/user/balance",
	grok: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	kimi: "https://api.kimi.com/coding/v1/usages",
} as const;

export class ManagementHttpError extends Error {
	constructor(
		public readonly status: number,
		message = `management HTTP ${status}`,
	) {
		super(message);
		this.name = "ManagementHttpError";
	}
}

function normalizedBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		url.pathname = url.pathname
			.replace(/\/+$/, "")
			.replace(/\/v0\/management$/i, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return undefined;
	}
}

async function configuredProviderBaseUrl(
	providerConfigPath?: string,
): Promise<string | undefined> {
	if (!providerConfigPath) return undefined;
	try {
		const value = JSON.parse(
			await readFile(providerConfigPath, "utf8"),
		) as Record<string, unknown>;
		return typeof value.baseUrl === "string"
			? normalizedBaseUrl(value.baseUrl)
			: undefined;
	} catch {
		return undefined;
	}
}

export async function resolveManagementSource(
	config: Config,
	providerConfigPath?: string,
): Promise<ManagementSource> {
	const providerBaseUrl = await configuredProviderBaseUrl(providerConfigPath);
	const managementKeyConfigured = Boolean(config.managementKey);
	if (config.managementUrl) {
		const managementUrl = normalizedBaseUrl(config.managementUrl);
		return managementUrl
			? { providerBaseUrl, managementUrl, managementKeyConfigured }
			: {
					providerBaseUrl,
					managementKeyConfigured,
					error: "invalid managementUrl",
				};
	}
	return {
		providerBaseUrl,
		managementUrl: providerBaseUrl,
		managementKeyConfigured,
	};
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

function providerName(value?: string): ProviderName | undefined {
	const provider = value?.toLowerCase();
	if (provider === "xai") return "grok";
	if (provider === "anthropic") return "claude";
	if (
		provider === "claude" ||
		provider === "codex" ||
		provider === "deepseek" ||
		provider === "grok" ||
		provider === "kimi"
	) {
		return provider;
	}
	return undefined;
}

function remoteProvider(auth: RemoteAuthFile): ProviderName | undefined {
	for (const value of [
		auth.provider,
		auth.account_type,
		auth.label,
		auth.name,
	]) {
		if (!value) continue;
		const direct = providerName(value);
		if (direct) return direct;
		const inferred = providerForModel("cliproxyapi", value);
		if (inferred) return inferred;
	}
	return undefined;
}

function remoteLabel(auth: RemoteAuthFile): string {
	return (
		auth.email ||
		auth.label ||
		basename(auth.name || "remote", ".json").replace(
			/^(claude|codex|xai|grok|kimi|deepseek)-/,
			"",
		)
	);
}

function parseUsageResponse(
	provider: ProviderName,
	response: UsageResponse,
): Pick<AccountUsage, "windows" | "balance"> {
	if (provider === "claude") return parseClaude(response.body);
	if (provider === "codex") {
		const parsed = parseCodex(response.body);
		if (!parsed.windows.length) {
			const used = toNumber(
				response.headers.get("x-codex-primary-used-percent"),
			);
			if (used !== undefined) parsed.windows.push({ label: "limit", used });
		}
		return parsed;
	}
	if (provider === "deepseek") {
		const parsed = parseDeepSeek(response.body);
		if (!parsed.balance?.amounts.length) throw new Error("missing balance");
		return parsed;
	}
	if (provider === "kimi") return parseKimi(response.body);
	return parseGrok(response.body);
}

function usageHeaders(
	provider: ProviderName,
	accountId?: string,
): Record<string, string> {
	if (provider === "claude") {
		return {
			"anthropic-beta": "oauth-2025-04-20",
			"Content-Type": "application/json",
		};
	}
	if (provider === "codex" && accountId) {
		return { "ChatGPT-Account-Id": accountId };
	}
	if (provider === "grok") return { "X-XAI-Token-Auth": "xai-grok-cli" };
	return {};
}

function managementEndpoint(baseUrl: string, path: string): string {
	return `${baseUrl}/v0/management${path}`;
}

async function managementRequest(
	baseUrl: string,
	managementKey: string,
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${managementKey}`);
	headers.set("Accept", "application/json");
	headers.set("User-Agent", "pi-cliproxy-usage");
	const response = await fetch(managementEndpoint(baseUrl, path), {
		...init,
		headers,
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new ManagementHttpError(response.status);
	return response;
}

async function readAuthFiles(
	baseUrl: string,
	managementKey: string,
): Promise<RemoteAuthFile[]> {
	const response = await managementRequest(
		baseUrl,
		managementKey,
		"/auth-files",
	);
	const value = (await response.json()) as { files?: unknown };
	if (!Array.isArray(value.files)) {
		throw new Error("invalid management auth-files response");
	}
	return value.files.map((item) => item as RemoteAuthFile);
}

function isOfficialDeepSeekUrl(value?: string): boolean {
	if (!value) return false;
	try {
		return new URL(value).hostname.toLowerCase() === "api.deepseek.com";
	} catch {
		return false;
	}
}

async function readDeepSeekAuthFiles(
	baseUrl: string,
	managementKey: string,
): Promise<RemoteAuthFile[]> {
	const response = await managementRequest(
		baseUrl,
		managementKey,
		"/openai-compatibility",
	);
	const value = (await response.json()) as {
		"openai-compatibility"?: unknown;
	};
	const providers = value["openai-compatibility"];
	if (!Array.isArray(providers)) {
		throw new Error("invalid management openai-compatibility response");
	}
	const files: RemoteAuthFile[] = [];
	for (const item of providers) {
		const provider = item as OpenAICompatibilityProvider;
		if (provider.disabled || !isOfficialDeepSeekUrl(provider["base-url"])) {
			continue;
		}
		const indexes = [
			provider["auth-index"],
			...(provider["api-key-entries"] ?? []).map(
				(entry) => entry["auth-index"],
			),
		].filter((index): index is string => Boolean(index));
		const uniqueIndexes = [...new Set(indexes)];
		for (const [index, authIndex] of uniqueIndexes.entries()) {
			files.push({
				auth_index: authIndex,
				provider: "deepseek",
				label:
					uniqueIndexes.length > 1
						? `${provider.name || "DeepSeek"} ${index + 1}`
						: provider.name || "DeepSeek",
			});
		}
	}
	return files;
}

export async function validateManagementAccess(
	config: Config,
	providerConfigPath?: string,
	managementKey = config.managementKey,
): Promise<string> {
	const source = await resolveManagementSource(config, providerConfigPath);
	if (source.error) throw new Error(source.error);
	if (!source.managementUrl) {
		throw new Error(
			"CLIProxyAPI base URL not found; configure the provider or managementUrl",
		);
	}
	if (!managementKey) throw new Error("management key is required");
	await readAuthFiles(source.managementUrl, managementKey);
	return source.managementUrl;
}

function remoteHeaders(values?: Record<string, string | string[]>): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(values ?? {})) {
		for (const item of Array.isArray(value) ? value : [value]) {
			headers.append(name, item);
		}
	}
	return headers;
}

async function remoteUsageRequest(
	baseUrl: string,
	managementKey: string,
	auth: RemoteAuthFile,
	provider: ProviderName,
): Promise<UsageResponse> {
	if (!auth.auth_index) throw new Error("missing remote auth_index");
	const response = await managementRequest(
		baseUrl,
		managementKey,
		"/api-call",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				auth_index: auth.auth_index,
				method: "GET",
				url: USAGE_URLS[provider],
				header: {
					Authorization: "Bearer $TOKEN$",
					Accept: "application/json",
					"User-Agent": "pi-cliproxy-usage",
					...usageHeaders(provider, auth.account_id),
				},
			}),
		},
	);
	const result = (await response.json()) as RemoteApiCallResponse;
	if (
		typeof result.status_code !== "number" ||
		result.status_code < 200 ||
		result.status_code >= 300
	) {
		throw new Error(
			typeof result.status_code === "number"
				? `HTTP ${result.status_code}`
				: "invalid remote API response",
		);
	}
	let body = result.body;
	if (typeof body === "string") {
		try {
			body = JSON.parse(body);
		} catch {
			throw new Error("invalid provider response");
		}
	}
	return { body, headers: remoteHeaders(result.header) };
}

async function fetchRemoteUsage(
	baseUrl: string,
	managementKey: string,
	auth: RemoteAuthFile,
	provider: ProviderName,
): Promise<AccountUsage> {
	const label = remoteLabel(auth);
	try {
		if (auth.unavailable) {
			throw new Error(auth.status_message || auth.status || "unavailable");
		}
		const response = await remoteUsageRequest(
			baseUrl,
			managementKey,
			auth,
			provider,
		);
		return { provider, label, ...parseUsageResponse(provider, response) };
	} catch (error) {
		return {
			provider,
			label,
			windows: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function sourceErrors(config: Config, message: string): AccountUsage[] {
	return (Object.keys(config.providers) as ProviderName[])
		.filter((provider) => config.providers[provider])
		.map((provider) => ({
			provider,
			label: "remote",
			windows: [],
			error: message,
		}));
}

function managementErrorMessage(error: unknown): string {
	if (error instanceof ManagementHttpError) {
		if (error.status === 401 || error.status === 403) {
			return `management authentication failed (HTTP ${error.status}); run /cliproxy-usage setup`;
		}
		if (error.status === 404) {
			return "Management API not found (HTTP 404); check CLIProxyAPI configuration or managementUrl";
		}
	}
	return error instanceof Error ? error.message : String(error);
}

export async function readAccounts(
	config: Config,
	options: ReadAccountsOptions = {},
): Promise<AccountUsage[]> {
	const source = await resolveManagementSource(
		config,
		options.providerConfigPath,
	);
	if (source.error) return sourceErrors(config, source.error);
	if (!source.managementUrl) {
		return sourceErrors(
			config,
			"CLIProxyAPI base URL not found; configure the provider or managementUrl",
		);
	}
	if (!config.managementKey) {
		return sourceErrors(
			config,
			"Management key is not configured; run /cliproxy-usage setup",
		);
	}
	try {
		const files = await readAuthFiles(
			source.managementUrl,
			config.managementKey,
		);
		let deepSeekFiles: RemoteAuthFile[] = [];
		let deepSeekDiscoveryError: AccountUsage | undefined;
		if (config.providers.deepseek) {
			try {
				deepSeekFiles = await readDeepSeekAuthFiles(
					source.managementUrl,
					config.managementKey,
				);
			} catch (error) {
				deepSeekDiscoveryError = {
					provider: "deepseek",
					label: "remote",
					windows: [],
					error: managementErrorMessage(error),
				};
			}
		}
		const accounts = [...files, ...deepSeekFiles]
			.map((auth) => ({ auth, provider: remoteProvider(auth) }))
			.filter(
				(entry): entry is { auth: RemoteAuthFile; provider: ProviderName } =>
					Boolean(
						entry.provider &&
							!entry.auth.disabled &&
							config.providers[entry.provider] &&
							(entry.provider !== "deepseek" ||
								deepSeekFiles.includes(entry.auth)),
					),
			);
		const seen = new Set<string>();
		const uniqueAccounts = accounts.filter(({ auth, provider }) => {
			const key = `${provider}:${auth.auth_index || auth.name || auth.label || ""}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
		const results = await Promise.all(
			uniqueAccounts.map(({ auth, provider }) =>
				fetchRemoteUsage(
					source.managementUrl as string,
					config.managementKey,
					auth,
					provider,
				),
			),
		);
		if (deepSeekDiscoveryError) results.push(deepSeekDiscoveryError);
		return results;
	} catch (error) {
		if (
			error instanceof ManagementHttpError &&
			(error.status === 401 || error.status === 403)
		) {
			options.onManagementAuthFailure?.();
		}
		return sourceErrors(config, managementErrorMessage(error));
	}
}
