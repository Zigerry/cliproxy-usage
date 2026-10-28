import {
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { PROVIDER_LABELS } from "./providers.js";
import type {
	AccountUsage,
	AccountUsageSnapshot,
	BalanceAmount,
	ReadonlyAccountBalance,
	Theme,
	UiContext,
	UsageWindow,
	UsageSnapshot,
} from "./types.js";

const plainTheme: Theme = { fg: (_color, text) => text };
const barWidths = [8, 6, 4, 0];

/** Remaining quota in percent, clamped to 0-100. */
export function remainingPercent(window: Readonly<UsageWindow>): number {
	return Math.max(0, Math.min(100, 100 - window.used));
}

/** Color by remaining quota: green normally, yellow below 30%, red below 10%. */
export function remainingColor(
	remaining: number,
): "error" | "warning" | "success" {
	if (remaining < 10) return "error";
	if (remaining < 30) return "warning";
	return "success";
}

export function usageBar(percent: number, width = 8): string {
	const value = Math.max(0, Math.min(100, percent));
	const filled = Math.round((value / 100) * width);
	return "━".repeat(filled) + "─".repeat(width - filled);
}

function formatWindow(window: Readonly<UsageWindow>): string {
	const remaining = remainingPercent(window);
	return `${window.label} ${usageBar(remaining)} left ${Math.round(remaining)}%`;
}

export function formatResetTime(resetsAt: Date, now = Date.now()): string {
	if (!Number.isFinite(resetsAt.getTime()) || !Number.isFinite(now)) return "reset unknown";
	const remainingMinutes = Math.max(
		0,
		Math.ceil((resetsAt.getTime() - now) / 60_000),
	);
	if (remainingMinutes === 0) return "reset due";
	if (remainingMinutes < 60) return `resets in ${remainingMinutes}m`;
	const hours = Math.floor(remainingMinutes / 60);
	const minutes = remainingMinutes % 60;
	if (hours < 48) {
		return `resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
	}
	const days = Math.floor(hours / 24);
	const remainingHours = hours % 24;
	return `resets in ${days}d${remainingHours ? ` ${remainingHours}h` : ""}`;
}

function formatDetailWindow(window: Readonly<UsageWindow>, now: number): string {
	const reset = window.resetsAt ? ` · ${formatResetTime(window.resetsAt, now)}` : "";
	return `${formatWindow(window)}${reset}`;
}

function fitLabel(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	return `${sliceByColumn(text, 0, Math.max(0, width - 1), true)}…`;
}

/** Prose only: never use this to fit a quota or amount. Input is sanitized snapshot text. */
export function layoutProse(text: string, width: number): string[] {
	if (width <= 0) return [];
	return wrapTextWithAnsi(text, width).map((line) => truncateToWidth(line, width, "…"));
}

function omitted(field: string, width: number): string {
	const text = `[${field} omitted]`;
	return visibleWidth(text) <= width ? text : width > 0 ? "…" : "";
}

/** Keep the window label and complete remaining percentage together, before decoration. */
export function layoutQuotaWindow(
	window: Readonly<UsageWindow>, width: number, theme: Theme, barWidth = 8, now?: number,
): string[] {
	if (width <= 0) return [];
	const remaining = remainingPercent(window);
	const color = remainingColor(remaining);
	const left = `left ${Math.round(remaining)}%`;
	const minimum = `${window.label} ${left}`;
	if (visibleWidth(minimum) > width) return [theme.fg("dim", omitted("quota", width))];
	const size = barWidths.find((size) => size <= barWidth && visibleWidth(minimum) + (size ? size + 1 : 0) <= width) ?? 0;
	const bar = usageBar(remaining, size);
	const filled = bar.match(/^━*/)?.[0] ?? "";
	const meter = size ? `${theme.fg(color, filled)}${theme.fg("dim", bar.slice(filled.length))} ` : "";
	const quota = `${theme.fg("muted", window.label)} ${meter}${theme.fg(color, left)}`;
	if (now === undefined || !window.resetsAt) return [quota];
	const reset = formatResetTime(window.resetsAt, now);
	if (visibleWidth(quota) + 3 + visibleWidth(reset) <= width) return [`${quota}${theme.fg("dim", ` · ${reset}`)}`];
	return [quota, theme.fg("dim", visibleWidth(reset) <= width ? reset : omitted("reset", width))];
}

/** Pack atomic fields or single-line cards; multiline cards always stay together. */
function packFields(
	fields: readonly (string | readonly string[])[], width: number, separator: string,
	maxPerRow = Infinity,
): string[] {
	const lines: string[] = [];
	let row: string[] = [];
	const flush = () => {
		if (row.length) lines.push(row.join(separator));
		row = [];
	};
	for (const field of fields) {
		if (typeof field !== "string" && field.length !== 1) {
			flush();
			lines.push(...field);
			continue;
		}
		const next = typeof field === "string" ? field : field[0] ?? "";
		if (row.length && (row.length >= maxPerRow ||
			visibleWidth(row.join(separator)) + visibleWidth(separator) + visibleWidth(next) > width)) flush();
		row.push(next);
	}
	flush();
	return lines;
}

/** Multiline cards keep these rows together; no final whole-row truncation. */
export function layoutQuotaWindows(
	windows: readonly Readonly<UsageWindow>[], width: number, theme: Theme, barWidth = 8,
): string[] {
	const candidates = barWidths.filter((size) => size <= barWidth).map((size) => ({ size,
		rows: packFields(windows.flatMap((window) => layoutQuotaWindow(window, width, plainTheme, size)), width, " │ "),
	}));
	const best = candidates.sort((a, b) => a.rows.length - b.rows.length)[0];
	return packFields(windows.flatMap((window) => layoutQuotaWindow(window, width, theme, best?.size ?? 0)), width, theme.fg("dim", " │ "));
}

/** Distinguish shortened/colliding public labels without exposing opaque account IDs. */
export function layoutAccountIdentity(
	provider: string, label: string, ordinal: number, width: number, theme: Theme,
	labelLimit = width, separator = " │ ", numbered = false,
): string {
	if (width <= 0) return "";
	if (!label && numbered) label = "remote";
	if (!label) return fitLabel(provider, width);
	let prefix = provider ? provider + theme.fg("dim", separator) : "";
	if (width - visibleWidth(prefix) < 6) prefix = "";
	const budget = Math.max(0, Math.min(labelLimit, width - visibleWidth(prefix)));
	const suffix = numbered || visibleWidth(label) > budget ? ` #${ordinal}` : "";
	const identity = suffix
		? budget >= visibleWidth(suffix) ? fitLabel(label, budget - visibleWidth(suffix)) + suffix : fitLabel(`#${ordinal}`, budget)
		: label;
	return prefix + theme.fg("muted", identity);
}

export function formatBalanceAmount(value: Readonly<BalanceAmount>): string {
	const symbols: Record<string, string> = {
		CNY: "¥",
		EUR: "€",
		GBP: "£",
		JPY: "¥",
		RMB: "¥",
		USD: "$",
	};
	const currency = value.currency.toUpperCase();
	const amount = value.amount.toFixed(2);
	return symbols[currency]
		? `${symbols[currency]}${amount}`
		: `${amount} ${currency}`;
}

function balanceFields(balance: ReadonlyAccountBalance): string[] {
	const symbols = new Map<string, Set<string>>();
	for (const value of balance.amounts) {
		const currency = value.currency.toUpperCase();
		const symbol = currency === "CNY" || currency === "JPY" || currency === "RMB" ? "¥" : currency;
		const codes = symbols.get(symbol) ?? new Set<string>();
		codes.add(currency);
		symbols.set(symbol, codes);
	}
	return balance.amounts.map((value) => {
		const currency = value.currency.toUpperCase();
		const ambiguous = ["CNY", "JPY", "RMB"].includes(currency) && (symbols.get("¥")?.size ?? 0) > 1;
		return formatBalanceAmount(value) + (ambiguous ? ` ${currency}` : "");
	});
}

export function formatBalance(balance: ReadonlyAccountBalance): string {
	return balanceFields(balance).join(" / ");
}

/** Amount, sign and required currency identifier are a single field. */
export function layoutBalance(balance: ReadonlyAccountBalance, width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	const unavailable = !balance.available || balance.amounts.every((value) => value.amount <= 0);
	const fields = balanceFields(balance).map((field) => visibleWidth(field) <= width
		? theme.fg(unavailable ? "error" : "text", field) : theme.fg("dim", omitted("balance", width)));
	return packFields(fields, width, theme.fg("dim", " / "));
}

/** Compact freshness and failure rows; details keep their additional age/query facts. */
function accountAnnotations(item: AccountUsageSnapshot): string[] {
	return [
		[item.incomplete ? "partial data" : "", item.cached ? "cached" : "", item.stale ? "stale" : ""].filter(Boolean).join(" · "),
		item.error ? `error: ${item.error}` : item.result === "error" ? "error" : "",
	].filter(Boolean);
}

function itemPriority(item: AccountUsageSnapshot): number {
	if (item.result === "error" || item.error) return Number.POSITIVE_INFINITY;
	if (item.balance) {
		const amount = Math.min(...item.balance.amounts.map((value) => value.amount));
		return Number.isFinite(amount) ? -amount : Number.NEGATIVE_INFINITY;
	}
	return Math.max(-1, ...item.windows.map((window) => window.used));
}

export function formatDetails(items: AccountUsage[], now = Date.now()): string {
	if (!items.length) return "No enabled CLIProxyAPI accounts found.";
	return items
		.map((item) => {
			const identity = item.label ? `${item.provider}/${item.label}` : item.provider;
			if (item.error) return `${identity}: ${item.error}`;
			if (item.balance) {
				return `${identity}: ${formatBalance(item.balance) || "No balance"}`;
			}
			const windows = item.windows.map((window) =>
				formatDetailWindow(window, now),
			);
			return `${identity}: ${windows.join(" · ") || "No usage window"}`;
		})
		.join("\n");
}

/** Short, shared state annotation; refreshing never masks retained failures. */
export function snapshotStatusText(snapshot: UsageSnapshot): string {
	const parts: string[] = [];
	if (snapshot.refreshing && snapshot.state !== "loading") parts.push("refreshing");
	const primary = snapshot.state === "ready" ? ""
		: snapshot.state === "setup-required" ? "setup required"
		: snapshot.state === "empty" ? "no accounts"
		: snapshot.state === "idle" ? "not refreshed" : snapshot.state;
	if (primary) parts.push(primary);
	if (snapshot.stale) parts.push("stale");
	if (snapshot.partial) parts.push("partial");
	if ((snapshot.eligibility?.manualAllowedAt ?? 0) > snapshot.generatedAt) parts.push("server wait");
	else if ((snapshot.eligibility?.automaticAllowedAt ?? 0) > snapshot.generatedAt) parts.push("backoff");
	if (snapshot.accounts.some((item) => item.cached)) parts.push("cached");
	if (snapshot.error || snapshot.accounts.some((item) => item.result === "error" || item.error)) {
		parts.push("error");
	}
	return [...new Set(parts)].join(" · ");
}

function timestamp(at: number | undefined): string | undefined {
	if (at === undefined || !Number.isFinite(at)) return undefined;
	const date = new Date(at);
	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

/** Safe age of a last-valid fact, not the age of the most recent refresh attempt. */
export function formatUsageAge(at: number | undefined, now: number): string {
	if (at === undefined || !timestamp(at) || !timestamp(now)) return "unknown";
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

/** Snapshot facts shared by details and non-TUI/status output. No cache inference. */
export function formatAccountSnapshotMetadata(item: AccountUsageSnapshot, now: number): string[] {
	const facts: string[] = [];
	if (item.incomplete) facts.push("partial data");
	if (item.lastValidAt !== undefined) {
		facts.push(`${item.result === "unknown" ? "last valid " : ""}data age: ${formatUsageAge(item.lastValidAt, now)}`);
	}
	if (item.result === "unknown") facts.push("unknown");
	if (item.cached) facts.push("cached");
	if (item.stale) facts.push("stale");
	if (item.error) facts.push(`error: ${item.error}`);
	else if (item.result === "error") facts.push("error");
	if (!item.queried) facts.push("not queried in latest outcome");
	const lines = facts.length ? [facts.join(" · ")] : [];
	if (item.attemptedAt !== undefined) {
		lines.push(`Last query attempt: ${timestamp(item.attemptedAt) ?? "unknown"}`);
	}
	return lines;
}

export function configurationStatusText(configuration: UsageSnapshot["configuration"]): string {
	if (configuration.status !== "setup-required") return "";
	if (configuration.message) return configuration.message;
	switch (configuration.reason) {
		case "missing-key": return "Management key is missing; run /cliproxy-usage setup.";
		case "missing-url": return "Management URL is missing; configure /cliproxy-usage settings.";
		case "invalid-source": return "Management source is invalid; check /cliproxy-usage settings.";
		case "rejected": return "Management access was rejected; run /cliproxy-usage setup.";
	}
}

/** Eligibility is a constraint, never a promise to issue HTTP at that time. */
export function formatRefreshEligibility(snapshot: UsageSnapshot): string[] {
	const policy = snapshot.eligibility;
	if (!policy) return [];
	const configured = snapshot.configuration.status === "ready";
	const revalidate = snapshot.configuration.status === "setup-required" && snapshot.configuration.reason === "rejected";
	const automatic = timestamp(policy.automaticAllowedAt);
	const manual = timestamp(policy.manualAllowedAt);
	return [
		`Earliest automatic request: ${configured ? automatic ?? "now" : "unavailable (configuration)"} (eligibility only)`,
		`Earliest manual request: ${manual ?? (configured || revalidate ? "now" : "unavailable (configuration)")}${manual ? " (server wait)" : revalidate ? " (force can revalidate Management access)" : configured && automatic ? " (force bypasses local backoff)" : ""}`,
		`Next automatic check: ${timestamp(policy.nextAutomaticCheckAt) ?? "none"} (not a request promise)`,
	];
}

/** Full metadata and data from the same snapshot used by both live views. */
export function formatSnapshotDetails(snapshot: UsageSnapshot): string {
	const lines = [
		`Usage state: ${snapshot.state}`,
		...(snapshotStatusText(snapshot) ? [`Status: ${snapshotStatusText(snapshot)}`] : []),
		`Last refresh: ${timestamp(snapshot.lastCompleteSuccessAt) ?? "never"} (complete success)`,
		`Last attempt: ${timestamp(snapshot.lastAttemptAt) ?? "never"}`,
		...formatRefreshEligibility(snapshot),
	];
	const configuration = configurationStatusText(snapshot.configuration);
	if (configuration) lines.push(configuration);
	if (snapshot.error) lines.push(`Error: ${snapshot.error}`);
	for (const item of snapshot.accounts) {
		const identity = item.label ? `${item.provider}/${item.label}` : item.provider;
		const data = item.result === "unknown" ? "unknown"
			: item.balance ? formatBalance(item.balance) || "unknown"
			: item.windows.map((window) => formatDetailWindow(window, snapshot.generatedAt)).join(" · ") || item.result;
		lines.push(`${identity}: ${data}`);
		for (const metadata of formatAccountSnapshotMetadata(item, snapshot.generatedAt)) lines.push(`  ${metadata}`);
	}
	return lines.join("\n");
}

export function clearUsage(ctx: UiContext): void {
	ctx.ui.setStatus("cliproxy-usage", undefined);
	ctx.ui.setWidget("cliproxy-usage", undefined);
}

export function renderUsage(
	ctx: UiContext,
	snapshot: UsageSnapshot,
	maxVisibleAccounts: number,
): void {
	if (snapshot.state === "unsupported" || snapshot.state === "disabled") {
		ctx.ui.setWidget("cliproxy-usage", undefined);
		return;
	}
	const items = snapshot.accounts;
	const status = snapshotStatusText(snapshot);
	const visibleItems = items
		.map((item, index) => ({
			item,
			index,
			priority: itemPriority(item),
		}))
		.sort(
			(left, right) =>
				right.priority - left.priority || left.index - right.index,
		)
		.slice(0, maxVisibleAccounts)
		.map(({ item }) => item);
	const hiddenCount = items.length - visibleItems.length;
	ctx.ui.setWidget(
		"cliproxy-usage",
		(_tui: unknown, theme: Theme) => ({
			invalidate() {},
			render(width: number): string[] {
				if (width <= 0) return [];
				const providers = new Set(visibleItems.map((item) => item.provider));
				const groupedProvider =
					providers.size === 1 && visibleItems.length > 1
						? visibleItems[0]?.provider
						: undefined;
				const styledProvider = (text: string) => theme.fg("text", text);
				const labelLimit = visibleItems.length > 1 ? 18 : 24;
				const buildCards = (barWidth: number, styled: boolean): string[][] =>
					visibleItems.map((item) => {
						const paintTheme = styled ? theme : plainTheme;
						const paint = (color: string, text: string) => paintTheme.fg(color, text);
						const ordinal = items.indexOf(item) + 1;
						const label = item.label || (visibleItems.length > 1 ? "remote" : "");
						const numbered = items.some((other) => other !== item &&
							(other.label || (visibleItems.length > 1 ? "remote" : "")) === label);
						const provider = groupedProvider ? "" : styled
							? styledProvider(PROVIDER_LABELS[item.provider]) : PROVIDER_LABELS[item.provider];
						const identity = (budget: number) => layoutAccountIdentity(provider, label, ordinal, budget, paintTheme, labelLimit, " │ ", numbered);
						const data = (budget: number, size = barWidth): string[] => item.result === "unknown"
							? [paint("dim", budget >= 7 ? "unknown" : omitted("unknown", budget))]
							: item.balance ? layoutBalance(item.balance, budget, paintTheme)
							: item.windows.length ? layoutQuotaWindows(item.windows, budget, paintTheme, size)
							: [paint("dim", budget >= 7 ? (item.result === "error" ? "error" : "unknown") : omitted(item.result === "error" ? "error" : "unknown", budget))];
						const annotationRows = accountAnnotations(item);
						const annotations = annotationRows.join(" · ");
						// Try a single row, shortening identity before meters. Never fit by
						// cutting a completed quota/balance row or its freshness annotation.
						for (const size of barWidths.filter((size) => size <= barWidth)) {
							const fullData = data(Number.MAX_SAFE_INTEGER, size).join(paint("dim", " │ "));
							const content = fullData + (annotations ? paint(item.error ? "error" : "dim", ` · ${annotations}`) : "");
							const identityBudget = width - visibleWidth(content) - 3;
							const providerWidth = provider ? visibleWidth(provider) + (label ? 3 : 0) : 0;
							if (identityBudget >= providerWidth + (label ? 6 : 0)) {
								const header = identity(identityBudget);
								return [header + (header ? paint("dim", " │ ") : "") + content];
							}
						}
						const indent = width >= 4 ? "  " : "";
						const bodyWidth = width - visibleWidth(indent);
						return [identity(width), ...data(bodyWidth).map((line) => indent + line),
							...annotationRows.flatMap((text) => layoutProse(paint(item.error ? "error" : "dim", text), bodyWidth))
								.map((line) => indent + line)];
					});
				const packCards = (cards: string[][]) => packFields(cards, width, "    ", 3);
				const candidates = [8, 6, 4].map((barWidth) => ({ barWidth, rows: packCards(buildCards(barWidth, false)) }));
				candidates.sort((a, b) => a.rows.length - b.rows.length || b.barWidth - a.barWidth);
				const rows = packCards(buildCards(candidates[0]?.barWidth ?? 8, true));
				const lines: string[] = status ? layoutProse(theme.fg("dim", status), width) : [];
				if (groupedProvider) {
					const count = items.length;
					const kind = groupedProvider === "deepseek" ? "balance" : "quota";
					lines.push(
						truncateToWidth(
							`${styledProvider(PROVIDER_LABELS[groupedProvider])} ${theme.fg(
								"dim",
								`${kind} · ${count} account${count === 1 ? "" : "s"}`,
							)}`,
							width,
							"…",
						),
					);
				}
				for (const row of rows) {
					lines.push(row);
				}
				if (hiddenCount) {
					lines.push(
						truncateToWidth(
							theme.fg(
								"dim",
								`… ${hiddenCount} more account${hiddenCount === 1 ? "" : "s"} · /cliproxy-usage for details`,
							),
							width,
							"…",
						),
					);
				}
				return lines;
			},
		}),
		{ placement: "belowEditor" },
	);
}
