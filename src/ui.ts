import {
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { PROVIDER_LABELS } from "./providers.js";
import type {
	AccountUsage,
	AccountUsageSnapshot,
	BalanceAmount,
	ProviderName,
	ReadonlyAccountBalance,
	Theme,
	UiContext,
	UsageWindow,
	UsageSnapshot,
} from "./types.js";

const CLAUDE_ORANGE = "\u001b[38;5;208m";

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
	if (visibleWidth(text) <= width) return text;
	const ellipsis = "…";
	const contentWidth = Math.max(0, width - visibleWidth(ellipsis));
	return `${sliceByColumn(text, 0, contentWidth, true)}${ellipsis}`;
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

export function formatBalance(balance: ReadonlyAccountBalance): string {
	return balance.amounts.map(formatBalanceAmount).join(" / ");
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
				const gap = 4;
				const providers = new Set(visibleItems.map((item) => item.provider));
				const groupedProvider =
					providers.size === 1 && visibleItems.length > 1
						? visibleItems[0]?.provider
						: undefined;
				const styledProvider = (provider: ProviderName, text: string) =>
					provider === "claude"
						? `${CLAUDE_ORANGE}${text}\u001b[0m`
						: theme.fg("text", text);
				const labelLimit = visibleItems.length > 1 ? 18 : 24;
				const buildCards = (barWidth: number, styled: boolean) =>
					visibleItems.map((item) => {
						const paint = (color: string, text: string) =>
							styled ? theme.fg(color, text) : text;
						const separator = paint("dim", " │ ");
						const account = paint("muted", fitLabel(item.label, labelLimit));
						const provider = styled
							? styledProvider(item.provider, PROVIDER_LABELS[item.provider])
							: PROVIDER_LABELS[item.provider];
						const prefix = groupedProvider
							? item.label
								? account + separator
								: ""
							: provider + separator + (item.label ? account + separator : "");
						let content: string;
						if (item.result === "unknown") {
							content = paint("dim", "unknown");
						} else if (item.balance) {
							const amount = formatBalance(item.balance);
							const unavailable =
								!item.balance.available ||
								item.balance.amounts.every((value) => value.amount <= 0);
							content = amount
								? paint(unavailable ? "error" : "text", amount)
								: paint("dim", "–");
						} else {
							const meters = item.windows.map((window) => {
								const remaining = remainingPercent(window);
								const color = remainingColor(remaining);
								const bar = usageBar(remaining, barWidth);
								const filled = bar.match(/^━*/)?.[0] ?? "";
								const empty = bar.slice(filled.length);
								return [
									paint("muted", window.label),
									`${paint(color, filled)}${paint("dim", empty)}`,
									paint(color, `left ${Math.round(remaining)}%`),
								].join(" ");
							});
							content = meters.length
								? meters.join(paint("dim", " │ "))
								: paint("dim", item.result === "error" ? "" : "unknown");
						}
						const annotations = [
							...(item.cached ? ["cached"] : []),
							...(item.stale ? ["stale"] : []),
							...(item.error ? [`! ${item.error}`] : item.result === "error" ? ["error"] : []),
						];
						if (annotations.length) content += paint(item.error ? "error" : "dim", `${content ? " · " : ""}${annotations.join(" · ")}`);
						const card = `${prefix}${content}`;
						return truncateToWidth(card, width, "");
					});
				const packCards = (cards: string[]): string[][] => {
					const rows: string[][] = [];
					let row: string[] = [];
					let rowWidth = 0;
					for (const card of cards) {
						const cardWidth = visibleWidth(card);
						const nextWidth =
							rowWidth + (row.length ? gap : 0) + cardWidth;
						if (row.length && (row.length >= 3 || nextWidth > width)) {
							rows.push(row);
							row = [];
							rowWidth = 0;
						}
						rowWidth += (row.length ? gap : 0) + cardWidth;
						row.push(card);
					}
					if (row.length) rows.push(row);
					return rows;
				};
				const candidates = [8, 6, 4].map((barWidth) => {
					const rows = packCards(buildCards(barWidth, false));
					return {
						barWidth,
						rows,
						maxColumns: Math.max(0, ...rows.map((row) => row.length)),
					};
				});
				candidates.sort(
					(left, right) =>
						left.rows.length - right.rows.length ||
						right.maxColumns - left.maxColumns ||
						right.barWidth - left.barWidth,
				);
				const layout = candidates[0];
				const rows = packCards(buildCards(layout?.barWidth ?? 8, true));
				const lines: string[] = status
					? [truncateToWidth(theme.fg("dim", status), width, "")] : [];
				if (groupedProvider) {
					const count = items.length;
					const kind = groupedProvider === "deepseek" ? "balance" : "quota";
					lines.push(
						truncateToWidth(
							`${styledProvider(groupedProvider, PROVIDER_LABELS[groupedProvider])} ${theme.fg(
								"dim",
								`${kind} · ${count} account${count === 1 ? "" : "s"}`,
							)}`,
							width,
							"",
						),
					);
				}
				for (const row of rows) {
					lines.push(row.join(" ".repeat(gap)));
				}
				if (hiddenCount) {
					lines.push(
						truncateToWidth(
							theme.fg(
								"dim",
								`… ${hiddenCount} more account${hiddenCount === 1 ? "" : "s"} · /cliproxy-usage for details`,
							),
							width,
							"",
						),
					);
				}
				return lines;
			},
		}),
		{ placement: "belowEditor" },
	);
}
