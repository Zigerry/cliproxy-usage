import type {
	AccountUsageSnapshot,
	AccountUsageState,
	ProviderName,
	ProviderReadResult,
	ProviderUsageState,
	UsageConfiguration,
	UsageData,
	UsageSnapshot,
} from "./types.js";

/** Public text only: remove terminal instructions, credentials and unbounded remote text. */
export function safeUsageText(value: string, redactions: readonly string[] = []): string {
	let text = value
		// OSC (including hyperlinks), DCS/SOS/PM/APC, CSI, then short escape sequences.
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0e-\x1f\x7f-\x9f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "");

	// Exact known secrets are handled before the length limit, longest first.
	for (const secret of [...redactions].filter(Boolean).sort((a, b) => b.length - a.length)) {
		text = text.split(secret).join("[REDACTED]");
	}
	text = text
		.replace(/\bBearer\s+(?:\[REDACTED\]|"[^"]*"|'[^']*'|[^\s"',;}\]<>]+)/gi, "Bearer [REDACTED]")
		.replace(/\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|management[_-]?key|token|authorization|password|secret)\b["']?\s*[:=]\s*)(?:\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "$1[REDACTED]")
		.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/g, "[REDACTED]")
		.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
		.replace(/\s+/g, " ").trim();
	// Count Unicode code points, never split a surrogate pair.
	return Array.from(text).slice(0, 240).join("");
}

function safeId(value: string | undefined, redactions: readonly string[]): string | undefined {
	// IDs are opaque matching keys, never rendered text. Preserve exact whitespace
	// and length; sanitizing them would silently change B's identity contract.
	return value && value.trim() && !redactions.some((secret) => secret && value.includes(secret)) ? value : undefined;
}

function cloneData(data: UsageData, redactions: readonly string[]): UsageData {
	const windows = data.windows.filter((window) => Number.isFinite(window.used)).map((window) => {
		const reset = window.resetsAt?.getTime();
		return {
			label: safeUsageText(window.label, redactions),
			used: window.used,
			...(reset !== undefined && Number.isFinite(reset) ? { resetsAt: new Date(reset) } : {}),
		};
	});
	const amounts = data.balance?.amounts.filter((amount) => Number.isFinite(amount.amount)).map((amount) => ({
		currency: safeUsageText(amount.currency, redactions), amount: amount.amount,
	}));
	return {
		windows,
		...(data.balance && amounts?.length ? { balance: { available: data.balance.available, amounts } } : {}),
	};
}

function hasData(data: UsageData): boolean {
	return data.windows.length > 0 || (data.balance?.amounts.length ?? 0) > 0;
}

function cloneAccount(account: AccountUsageState, redactions: readonly string[]): AccountUsageState {
	return {
		provider: account.provider,
		accountId: safeId(account.accountId, redactions),
		label: safeUsageText(account.label, redactions),
		queried: account.queried,
		attemptedAt: account.attemptedAt,
		result: account.result,
		...(account.error !== undefined ? { error: safeUsageText(account.error, redactions) } : {}),
		...(account.valid ? { valid: { at: account.valid.at, data: cloneData(account.valid.data, redactions) } } : {}),
	};
}

function cloneProvider(previous: ProviderUsageState | undefined, provider: ProviderName,
	redactions: readonly string[] = []): ProviderUsageState {
	if (!previous || previous.provider !== provider) return { provider, accounts: [] };
	return {
		provider,
		accounts: previous.accounts.map((account) => cloneAccount(account, redactions)),
		lastAttemptAt: previous.lastAttemptAt,
		lastCompleteSuccessAt: previous.lastCompleteSuccessAt,
		...(previous.discovery ? { discovery: {
			result: previous.discovery.result, at: previous.discovery.at,
			...(previous.discovery.error !== undefined ? { error: safeUsageText(previous.discovery.error, redactions) } : {}),
		} } : {}),
	};
}

/** Mark provider work, without inventing per-account HTTP attempts or changing old outcomes. */
export function beginProviderRead(previous: ProviderUsageState | undefined, provider: ProviderName,
	attemptedAt: number): ProviderUsageState {
	return { ...cloneProvider(previous, provider), lastAttemptAt: attemptedAt };
}

export function applyProviderRead(previous: ProviderUsageState | undefined, result: ProviderReadResult,
	timing: { attemptedAt: number; completedAt: number }, redactions: readonly string[] = []): ProviderUsageState {
	const record = cloneProvider(previous, result.provider, redactions);
	record.lastAttemptAt = timing.attemptedAt;
	if (result.discovery === "failure") {
		record.discovery = { result: "error", at: timing.completedAt, error: safeUsageText(result.error, redactions) };
		return record;
	}

	// Ambiguous or absent IDs cannot inherit history; display names and positions are never identities.
	const byId = new Map<string, AccountUsageState>();
	const duplicates = new Set<string>();
	for (const account of record.accounts) {
		if (!account.accountId) continue;
		if (byId.has(account.accountId)) duplicates.add(account.accountId);
		byId.set(account.accountId, account);
	}
	record.accounts = result.items.map((item): AccountUsageState => {
		const accountId = safeId(item.accountId, redactions);
		const old = accountId && !duplicates.has(accountId) ? byId.get(accountId) : undefined;
		const data = cloneData(item, redactions);
		const outcome = item.error !== undefined ? "error" : hasData(data) ? "valid" : "unknown";
		return {
			provider: result.provider, accountId, label: safeUsageText(item.label, redactions),
			queried: item.queried === true,
			attemptedAt: item.queried === true ? timing.attemptedAt : old?.attemptedAt,
			result: outcome,
			...(outcome === "error" ? { error: safeUsageText(item.error!, redactions) } : {}),
			...(outcome === "valid" ? { valid: { at: timing.completedAt, data } }
				: old?.valid ? { valid: { at: old.valid.at, data: cloneData(old.valid.data, redactions) } } : {}),
		};
	});
	record.discovery = { result: "success", at: timing.completedAt };
	if (record.accounts.every((account) => account.result === "valid")) {
		record.lastCompleteSuccessAt = timing.completedAt;
	}
	return record;
}

function expired(valid: NonNullable<AccountUsageState["valid"]>, now: number, maxAgeMs: number): boolean {
	return now - valid.at >= maxAgeMs || valid.data.windows.some((window) => {
		const reset = window.resetsAt?.getTime();
		return reset !== undefined && Number.isFinite(reset) && reset <= now;
	});
}

function cloneConfiguration(configuration: UsageConfiguration): UsageConfiguration {
	return configuration.status === "setup-required" ? {
		status: configuration.status, reason: configuration.reason,
		...(configuration.message !== undefined ? { message: safeUsageText(configuration.message) } : {}),
	} : { status: configuration.status };
}

export function deriveUsageSnapshot(input: {
	provider?: ProviderName;
	enabled: boolean;
	configuration: UsageConfiguration;
	record?: ProviderUsageState;
	refreshing: boolean;
	now: number;
	maxAgeMs: number;
}): UsageSnapshot {
	const { provider, enabled, refreshing, now, maxAgeMs } = input;
	const configuration = cloneConfiguration(input.configuration);
	const record = provider && input.record?.provider === provider ? input.record : undefined;
	const base = {
		provider, configuration, refreshing, generatedAt: now,
		lastAttemptAt: record?.lastAttemptAt, lastCompleteSuccessAt: record?.lastCompleteSuccessAt,
	};
	if (!provider || !enabled) {
		return { ...base, state: !provider ? "unsupported" : "disabled", accounts: [], stale: false, partial: false };
	}
	const discoveryError = record?.discovery?.result === "error";
	const setup = configuration.status === "setup-required";
	const accounts = (record?.accounts ?? []).map((account): AccountUsageSnapshot => {
		// Unknown is a current absence of data, even if a historical valid fact exists.
		const valid = account.result !== "unknown" ? account.valid : undefined;
		const cached = !!valid && (account.result === "error" || discoveryError || setup);
		const data = valid ? cloneData(valid.data, []) : { windows: [] };
		return {
			provider: account.provider, accountId: safeId(account.accountId, []),
			label: safeUsageText(account.label),
			...data,
			queried: account.queried, attemptedAt: account.attemptedAt, lastValidAt: account.valid?.at,
			result: account.result,
			...(account.error !== undefined ? { error: safeUsageText(account.error) } : {}),
			cached,
			stale: !!valid && (account.result === "error" || discoveryError || setup || expired(valid, now, maxAgeMs)),
		};
	});
	const validCount = accounts.filter((account) => account.result === "valid").length;
	const errorCount = accounts.filter((account) => account.result === "error").length;
	let state: UsageSnapshot["state"];
	let partial = false;
	if (setup) state = "setup-required";
	else if (!record?.discovery && accounts.length === 0) state = refreshing ? "loading" : "idle";
	else if (discoveryError) state = "error";
	else if (accounts.length === 0) state = "empty";
	else if (validCount > 0) {
		state = "ready";
		partial = validCount < accounts.length;
	} else if (errorCount > 0) {
		state = "error";
		partial = errorCount < accounts.length;
	} else state = "unknown";

	const error = setup ? configuration.message
		: discoveryError ? record?.discovery?.error
		: accounts.map((account) => account.error).filter(Boolean).join("; ");
	return {
		...base, state, partial, accounts, stale: accounts.some((account) => account.stale),
		...(error ? { error: safeUsageText(error) } : {}),
	};
}

/** Next local repaint boundary; never schedules I/O or returns a due/expired deadline. */
export function nextFreshnessDeadline(record: ProviderUsageState | undefined, now: number,
	maxAgeMs: number): number | undefined {
	if (!record || record.discovery?.result === "error") return undefined;
	let next: number | undefined;
	const consider = (deadline: number) => {
		if (Number.isFinite(deadline) && deadline > now && (next === undefined || deadline < next)) next = deadline;
	};
	for (const account of record.accounts) {
		const valid = account.valid;
		if (account.result !== "valid" || !valid || !hasData(valid.data) || expired(valid, now, maxAgeMs)) continue;
		consider(valid.at + maxAgeMs);
		for (const window of valid.data.windows) {
			if (window.resetsAt) consider(window.resetsAt.getTime());
		}
	}
	return next;
}
