import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { abortable } from "./abort.js";
import { httpFailure, parseRetryAfter, RequestError, retryAfterFromRemoteHeaders } from "./http.js";
import {
	parseClaude,
	parseCodex,
	parseDeepSeek,
	parseGrok,
	parseKimi,
	toNumber,
} from "./parsers.js";
import { PROVIDERS } from "./providers.js";
import type {
	AccountUsage,
	ProviderName,
	ProviderReadResult,
	ReadAccountsResult,
	RequestFailure,
	Settings,
} from "./types.js";

type RemoteAuthFile = {
	auth_index?: unknown;
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

type UsageResponse = { body: unknown; headers: Headers };

type RemoteApiCallResponse = {
	status_code?: number;
	header?: unknown;
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
	providers?: readonly ProviderName[];
	source?: ManagementSource;
	signal?: AbortSignal;
};

const USAGE_URLS = {
	claude: "https://api.anthropic.com/api/oauth/usage",
	codex: "https://chatgpt.com/backend-api/wham/usage",
	deepseek: "https://api.deepseek.com/user/balance",
	grok: "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	kimi: "https://api.kimi.com/coding/v1/usages",
} as const;

export class ManagementHttpError extends RequestError {
	constructor(
		public readonly status: number,
		message = `management HTTP ${status}`,
		retryAfterAt?: number,
	) {
		super(httpFailure("management", status, retryAfterAt), message);
		this.name = "ManagementHttpError";
	}
}

function normalizedBaseUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		url.pathname = url.pathname
			.replace(/\/+$/, "")
			.replace(/\/v0\/management$/i, "")
			.replace(/\/v1$/i, "");
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
	config: Settings,
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
	if ((PROVIDERS as readonly string[]).includes(provider ?? "")) {
		return provider as ProviderName;
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
	const label =
		auth.email ||
		auth.label ||
		basename(auth.name || "remote", ".json").replace(
			/^(claude|codex|xai|grok|kimi|deepseek)-/,
			"",
		);
	return label || "remote";
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
		if (!record(response.body) ||
			(response.body.is_available !== undefined && typeof response.body.is_available !== "boolean") ||
			(response.body.balance_infos !== undefined && (!Array.isArray(response.body.balance_infos) ||
				!response.body.balance_infos.every(record)))) {
			throw new Error("invalid balance response");
		}
		return parseDeepSeek(response.body);
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

type ManagementReport = (failure?: RequestFailure) => void;

function invalidResponse(scope: RequestFailure["scope"], message: string): RequestError {
	return new RequestError({ scope, category: "invalid-response" }, message);
}

/** A request's headers, JSON and validation share one budget and completion report. */
async function managementRequest<T = unknown>(
	baseUrl: string,
	managementKey: string,
	path: string,
	init: RequestInit = {},
	parent?: AbortSignal,
	report?: ManagementReport,
	decode: (value: unknown) => T = (value) => value as T,
): Promise<T> {
	parent?.throwIfAborted();
	const signal = AbortSignal.any([
		...(parent ? [parent] : []),
		AbortSignal.timeout(10_000),
	]);
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${managementKey}`);
	headers.set("Accept", "application/json");
	headers.set("User-Agent", "pi-cliproxy-usage");
	try {
		signal.throwIfAborted();
		const response = await abortable(fetch(managementEndpoint(baseUrl, path), {
			...init,
			headers,
			signal,
		}), signal);
		parent?.throwIfAborted();
		signal.throwIfAborted();
		if (!response.ok) {
			const retryAfterAt = parseRetryAfter(response.headers.get("retry-after"), Date.now());
			void response.body?.cancel().catch(() => {});
			throw new ManagementHttpError(response.status, undefined, retryAfterAt);
		}
		const value: unknown = await abortable(response.json(), signal);
		parent?.throwIfAborted();
		signal.throwIfAborted();
		const decoded = decode(value);
		parent?.throwIfAborted();
		report?.();
		return decoded;
	} catch (error) {
		// Cancellation is operation control: never report it as a completed request.
		parent?.throwIfAborted();
		const timeout = (error instanceof Error && error.name === "TimeoutError") || signal.aborted;
		const failure = error instanceof RequestError ? error : error instanceof SyntaxError
			? invalidResponse("management", "invalid management JSON response")
			: new RequestError({ scope: "management", category: timeout ? "timeout" : "network" },
				timeout ? "management request timed out" : "management request failed");
		report?.(failure.failure);
		throw failure;
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountId(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

async function readAuthFiles(
	baseUrl: string,
	managementKey: string,
	signal?: AbortSignal,
	report?: ManagementReport,
): Promise<RemoteAuthFile[]> {
	return managementRequest(baseUrl, managementKey, "/auth-files", {}, signal, report, (value) => {
		const invalid = () => invalidResponse("management", "invalid management auth-files response");
		if (!record(value) || !Array.isArray(value.files)) throw invalid();
		const files: RemoteAuthFile[] = [];
		for (const item of value.files) {
			if (!record(item)) throw invalid();
			if (item.disabled === true) continue;
			for (const key of ["provider", "name", "label", "email", "account_type", "account_id", "status", "status_message"]) {
				if (item[key] !== undefined && typeof item[key] !== "string") throw invalid();
			}
			for (const key of ["disabled", "unavailable"]) {
				if (item[key] !== undefined && typeof item[key] !== "boolean") throw invalid();
			}
			if (![item.provider, item.account_type, item.label, item.name].some(
				(field) => typeof field === "string" && field.trim(),
			)) throw invalid();
			// An invalid/missing auth_index is still a discovered account, never a selector.
			files.push(item as RemoteAuthFile);
		}
		return files;
	});
}

function isOfficialDeepSeekUrl(value: string): boolean {
	try {
		return new URL(value).hostname.toLowerCase() === "api.deepseek.com";
	} catch {
		return false;
	}
}

async function readDeepSeekAuthFiles(
	baseUrl: string,
	managementKey: string,
	signal?: AbortSignal,
	report?: ManagementReport,
): Promise<RemoteAuthFile[]> {
	return managementRequest(baseUrl, managementKey, "/openai-compatibility", {}, signal, report, (value) => {
		const invalid = () => invalidResponse("management", "invalid management openai-compatibility response");
		if (!record(value) || !Array.isArray(value["openai-compatibility"])) throw invalid();
		const files: RemoteAuthFile[] = [];
		for (const item of value["openai-compatibility"]) {
			if (!record(item)) throw invalid();
			if (item.disabled === true) continue;
			if ((item.disabled !== undefined && typeof item.disabled !== "boolean") ||
				typeof item["base-url"] !== "string" || !item["base-url"].trim()) throw invalid();
			if (!isOfficialDeepSeekUrl(item["base-url"])) continue;
			if (item.name !== undefined && typeof item.name !== "string") throw invalid();
			const label = item.name || "DeepSeek";
			const indexes: unknown[] = [];
			if (Object.hasOwn(item, "auth-index")) indexes.push(item["auth-index"]);
			if (Object.hasOwn(item, "api-key-entries")) {
				if (!Array.isArray(item["api-key-entries"])) throw invalid();
				for (const entry of item["api-key-entries"]) {
					if (!record(entry)) throw invalid();
					indexes.push(entry["auth-index"]);
				}
			} else if (!Object.hasOwn(item, "auth-index")) {
				// No complete key collection or legacy selector: cannot assert emptiness.
				throw invalid();
			}
			const seen = new Set<string>();
			const uniqueIndexes = indexes.filter((value) => {
				const id = accountId(value);
				if (!id) return true;
				if (seen.has(id)) return false;
				seen.add(id);
				return true;
			});
			for (const [index, authIndex] of uniqueIndexes.entries()) {
				files.push({
					auth_index: authIndex,
					provider: "deepseek",
					label: uniqueIndexes.length > 1 ? `${label} ${index + 1}` : label,
				});
			}
		}
		return files;
	});
}

export async function validateManagementAccess(
	config: Settings,
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

function remoteHeaders(values: unknown): Headers {
	const headers = new Headers();
	if (!record(values)) return headers;
	// This is the only provider response header used for quota parsing.
	for (const [name, value] of Object.entries(values)) {
		if (name.toLowerCase() !== "x-codex-primary-used-percent") continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			if (typeof item !== "string") continue;
			try { headers.append(name, item); } catch { /* Ignore malformed metadata. */ }
		}
	}
	return headers;
}

async function remoteUsageRequest(
	baseUrl: string,
	managementKey: string,
	auth: RemoteAuthFile,
	provider: ProviderName,
	signal?: AbortSignal,
	report?: ManagementReport,
): Promise<UsageResponse> {
	signal?.throwIfAborted();
	const id = accountId(auth.auth_index);
	if (!id) throw new Error("missing remote auth_index");
	const value = await managementRequest(
		baseUrl,
		managementKey,
		"/api-call",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				auth_index: id,
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
		signal,
		report,
		(value) => {
			if (!record(value) || !Number.isInteger(value.status_code) ||
				typeof value.status_code !== "number" || value.status_code < 100 || value.status_code > 599) {
				throw invalidResponse("management", "invalid remote API response");
			}
			// Capture at response decoding, not when sibling requests finish.
			return { result: value as RemoteApiCallResponse, now: Date.now() };
		},
	);
	signal?.throwIfAborted();
	const { result, now } = value;
	const status = result.status_code!;
	if (status < 200 || status >= 300) {
		throw new RequestError(httpFailure("provider", status, retryAfterFromRemoteHeaders(result.header, now)), `HTTP ${status}`);
	}
	let body = result.body;
	if (typeof body === "string") {
		try {
			body = JSON.parse(body);
		} catch {
			throw invalidResponse("provider", "invalid provider response");
		}
	}
	return { body, headers: remoteHeaders(result.header) };
}

function failedAccount(auth: RemoteAuthFile, provider: ProviderName, message: string, queried = false, failure?: RequestFailure): AccountUsage {
	const id = accountId(auth.auth_index);
	return {
		provider,
		...(id !== undefined ? { accountId: id } : {}),
		label: remoteLabel(auth),
		queried,
		windows: [],
		error: message,
		...(failure ? { failure } : {}),
	};
}

async function fetchRemoteUsage(
	baseUrl: string,
	managementKey: string,
	auth: RemoteAuthFile,
	provider: ProviderName,
	signal?: AbortSignal,
	report?: ManagementReport,
): Promise<AccountUsage> {
	signal?.throwIfAborted();
	let queried = false;
	try {
		if (auth.unavailable) throw new Error("account unavailable");
		if (!accountId(auth.auth_index)) throw new Error("missing remote auth_index");
		queried = true;
		const response = await remoteUsageRequest(baseUrl, managementKey, auth, provider, signal, report);
		signal?.throwIfAborted();
		let parsed: Pick<AccountUsage, "windows" | "balance">;
		try { parsed = parseUsageResponse(provider, response); }
		catch { throw invalidResponse("provider", "invalid provider response"); }
		const id = accountId(auth.auth_index);
		return {
			provider,
			...(id !== undefined ? { accountId: id } : {}),
			label: remoteLabel(auth),
			queried,
			...parsed,
		};
	} catch (error) {
		signal?.throwIfAborted();
		return failedAccount(auth, provider, managementErrorMessage(error), queried,
			error instanceof RequestError ? error.failure : undefined);
	}
}

function sourceErrors(providers: readonly ProviderName[], message: string): ReadAccountsResult {
	return {
		providers: providers.map((provider) => ({ provider, discovery: "failure", error: message })),
		managementAuthFailed: false,
	};
}

export function managementErrorMessage(
	error: unknown,
	mode: "refresh" | "setup" = "refresh",
): string {
	if (error instanceof ManagementHttpError) {
		if (error.status === 401 || error.status === 403) {
			return mode === "setup"
				? `Management password rejected (HTTP ${error.status}).`
				: `management authentication failed (HTTP ${error.status}); run /cliproxy-usage setup`;
		}
		if (error.status === 404) {
			return mode === "setup"
				? "Management API not found (HTTP 404). Check CLIProxyAPI management configuration."
				: "Management API not found (HTTP 404); check CLIProxyAPI configuration or managementUrl";
		}
	}
	return error instanceof Error ? error.message : String(error);
}

export async function readAccounts(
	config: Settings,
	options: ReadAccountsOptions = {},
): Promise<ReadAccountsResult> {
	const { signal } = options;
	signal?.throwIfAborted();
	const requested = options.providers ? new Set(options.providers) : undefined;
	const selectedProviders = PROVIDERS.filter(
		(provider) => config.providers[provider] && (!requested || requested.has(provider)),
	);
	if (!selectedProviders.length) return { providers: [], managementAuthFailed: false };
	const source = options.source ?? await abortable(
		resolveManagementSource(config, options.providerConfigPath), signal,
	);
	signal?.throwIfAborted();
	if (source.error) return sourceErrors(selectedProviders, source.error);
	if (!source.managementUrl) {
		return sourceErrors(selectedProviders,
			"CLIProxyAPI base URL not found; configure the provider or managementUrl");
	}
	if (!config.managementKey) {
		return sourceErrors(selectedProviders,
			"Management key is not configured; run /cliproxy-usage setup");
	}
	const managementUrl = source.managementUrl;
	const managementKey = config.managementKey;
	const discovered = new Map<ProviderName, RemoteAuthFile[]>();
	type DiscoveryFailure = { error: string; failure?: RequestFailure; attempted: boolean };
	const failures = new Map<ProviderName, DiscoveryFailure>();
	const management: NonNullable<ReadAccountsResult["management"]> = { attempted: false, failures: [] };
	let managementAuthFailed = false;
	let blocker: { error: string; failure: RequestFailure } | undefined;
	const report: ManagementReport = (failure) => {
		signal?.throwIfAborted();
		management.attempted = true;
		if (!failure) return;
		management.failures.push(failure);
		const auth = failure.category === "auth";
		if (auth) managementAuthFailed = true;
		// A known Management 429 also stops this round's unstarted work even
		// without a server deadline. Controller treats that as local backoff.
		if (auth || failure.category === "rate-limit" || (failure.retryAfterAt !== undefined && failure.retryAfterAt > Date.now())) {
			if (!blocker || (failure.retryAfterAt ?? 0) > (blocker.failure.retryAfterAt ?? 0)) {
				blocker = {
					failure,
					error: managementErrorMessage(new ManagementHttpError(failure.status!, undefined, failure.retryAfterAt)),
				};
			}
		}
	};
	const discoveryFailure = (error: unknown): DiscoveryFailure => ({
		error: managementErrorMessage(error),
		...(error instanceof RequestError ? { failure: error.failure } : {}),
		attempted: true,
	});
	const ordinary = selectedProviders.filter((provider) => provider !== "deepseek");
	if (ordinary.length) {
		try {
			const files = await readAuthFiles(managementUrl, managementKey, signal, report);
			signal?.throwIfAborted();
			for (const provider of ordinary) discovered.set(provider, []);
			for (const auth of files) {
				const provider = remoteProvider(auth);
				if (provider && !auth.disabled) discovered.get(provider)?.push(auth);
			}
		} catch (error) {
			signal?.throwIfAborted();
			for (const provider of ordinary) failures.set(provider, discoveryFailure(error));
		}
	}
	if (selectedProviders.includes("deepseek")) {
		if (blocker) failures.set("deepseek", { ...blocker, attempted: false });
		else {
			try {
				const files = await readDeepSeekAuthFiles(managementUrl, managementKey, signal, report);
				signal?.throwIfAborted();
				discovered.set("deepseek", files);
			} catch (error) {
				signal?.throwIfAborted();
				failures.set("deepseek", discoveryFailure(error));
			}
		}
	}
	const providers: ProviderReadResult[] = [];
	const queries: Promise<void>[] = [];
	for (const provider of selectedProviders) {
		signal?.throwIfAborted();
		const failure = failures.get(provider);
		if (failure !== undefined) {
			providers.push({ provider, discovery: "failure", ...failure });
			continue;
		}
		const seen = new Set<string>();
		const accounts = (discovered.get(provider) ?? []).filter((auth) => {
			const id = accountId(auth.auth_index);
			if (id === undefined) return true;
			if (seen.has(id)) return false;
			seen.add(id);
			return true;
		});
		const result = { provider, discovery: "success" as const, items: [] as AccountUsage[] };
		providers.push(result);
		// Preserve concurrent queries and stable order. Only unstarted work is skipped.
		queries.push(Promise.all(accounts.map(async (auth) => {
			signal?.throwIfAborted();
			if (blocker) return failedAccount(auth, provider, blocker.error, false, blocker.failure);
			const read = await fetchRemoteUsage(managementUrl, managementKey, auth, provider, signal, report);
			signal?.throwIfAborted();
			return read;
		})).then((items) => { signal?.throwIfAborted(); result.items = items; }));
	}
	await Promise.all(queries);
	signal?.throwIfAborted();
	return { providers, managementAuthFailed, management };
}
