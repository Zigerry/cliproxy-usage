import type { AccountUsage, UsageWindow } from "./types.js";

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function toDate(value: unknown): Date | undefined {
	if (typeof value === "string") {
		const parsed = new Date(value);
		return Number.isNaN(parsed.getTime()) ? undefined : parsed;
	}
	const raw = toNumber(value);
	if (raw === undefined) return undefined;
	return new Date(raw < 1e10 ? raw * 1000 : raw);
}

/** Human-readable window length: 18000 → "5h", 604800 → "7d". */
export function durationLabel(seconds: number): string {
	if (seconds % 86400 === 0) return `${seconds / 86400}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/** Keep every provider on the same layout: long window first, short window second. */
function windowRank(label: string): number {
	if (label.endsWith("d") || label.endsWith("w")) return 0;
	if (label.endsWith("h") || label.endsWith("m") || label.endsWith("s")) {
		return 1;
	}
	return 2;
}

function sortedWindows(candidates: Array<UsageWindow | undefined>): UsageWindow[] {
	return (candidates.filter(Boolean) as UsageWindow[]).sort(
		(left, right) => windowRank(left.label) - windowRank(right.label),
	);
}

function windows(
	...candidates: Array<UsageWindow | undefined>
): Pick<AccountUsage, "windows"> {
	return { windows: sortedWindows(candidates) };
}

export function parseClaude(body: unknown): Pick<AccountUsage, "windows"> {
	const root = body as Record<string, unknown>;
	const window = (
		value: unknown,
		label: string,
	): UsageWindow | undefined => {
		const item = value as Record<string, unknown> | undefined;
		const used = toNumber(item?.utilization);
		return used === undefined
			? undefined
			: { label, used, resetsAt: toDate(item?.resets_at) };
	};
	return windows(
		window(root?.seven_day, "7d"),
		window(root?.five_hour, "5h"),
	);
}

export function parseDeepSeek(
	body: unknown,
): Pick<AccountUsage, "windows" | "balance"> {
	const root = body as Record<string, unknown> | undefined;
	const infos = Array.isArray(root?.balance_infos) ? root.balance_infos : [];
	const amounts = infos.flatMap((value) => {
		const item = value as Record<string, unknown> | undefined;
		const amount = toNumber(item?.total_balance);
		const currency =
			typeof item?.currency === "string" ? item.currency.trim().toUpperCase() : "";
		return amount === undefined || !currency ? [] : [{ currency, amount }];
	});
	return {
		windows: [],
		balance: {
			available: root?.is_available !== false,
			amounts,
		},
	};
}

function codexWindow(
	value: unknown,
): (UsageWindow & { seconds?: number }) | undefined {
	const item = value as Record<string, unknown> | undefined;
	const used = toNumber(item?.used_percent);
	if (used === undefined) return undefined;
	const resetAfter = toNumber(item?.reset_after_seconds);
	return {
		label: "",
		used,
		seconds: toNumber(item?.limit_window_seconds),
		resetsAt:
			toDate(item?.reset_at) ??
			(resetAfter === undefined
				? undefined
				: new Date(Date.now() + resetAfter * 1000)),
	};
}

/**
 * Classify a Codex rate-limit window. The API does not guarantee which of
 * primary/secondary holds the 5-hour session window: on some plans primary
 * is the 7-day window. Classify by `limit_window_seconds` first, then fall
 * back to the reset distance, and only then to a neutral label — never
 * assume a slot means "session".
 */
function codexLabel(window: UsageWindow & { seconds?: number }): string {
	if (window.seconds !== undefined) return durationLabel(window.seconds);
	if (window.resetsAt !== undefined) {
		const hours = (window.resetsAt.getTime() - Date.now()) / 3_600_000;
		return hours <= 24 ? "5h" : "7d";
	}
	return "limit";
}

export function parseCodex(body: unknown): Pick<AccountUsage, "windows"> {
	const rate = (body as Record<string, unknown>)?.rate_limit as
		| Record<string, unknown>
		| undefined;
	const parsed = [
		codexWindow(rate?.primary_window),
		codexWindow(rate?.secondary_window),
	].filter(Boolean) as Array<UsageWindow & { seconds?: number }>;
	const labeled = parsed.map((window) => ({
		label: codexLabel(window),
		used: window.used,
		resetsAt: window.resetsAt,
	}));
	return { windows: sortedWindows(labeled) };
}

export function parseGrok(body: unknown): Pick<AccountUsage, "windows"> {
	const config = (body as Record<string, unknown>)?.config as
		| Record<string, unknown>
		| undefined;
	const period = config?.currentPeriod as Record<string, unknown> | undefined;
	if (period?.type !== "USAGE_PERIOD_TYPE_WEEKLY") return { windows: [] };
	return windows({
		label: "7d",
		used: toNumber(config?.creditUsagePercent) ?? 0,
		resetsAt: toDate(period.end),
	});
}

function kimiPercent(detail: Record<string, unknown>): number | undefined {
	const limit = toNumber(detail.limit);
	const used = toNumber(detail.used);
	if (used !== undefined && limit !== undefined && limit > 0) {
		return (used / limit) * 100;
	}
	const remaining = toNumber(detail.remaining);
	if (remaining !== undefined && limit !== undefined && limit > 0) {
		return ((limit - remaining) / limit) * 100;
	}
	return undefined;
}

function kimiWindowSeconds(value: unknown): number | undefined {
	const item = value as Record<string, unknown> | undefined;
	const duration = toNumber(item?.duration);
	if (duration === undefined) return undefined;
	switch (item?.timeUnit) {
		case "TIME_UNIT_MINUTE":
			return duration * 60;
		case "TIME_UNIT_HOUR":
			return duration * 3600;
		case "TIME_UNIT_DAY":
			return duration * 86400;
		case "TIME_UNIT_WEEK":
			return duration * 604800;
		default:
			return duration;
	}
}

export function parseKimi(body: unknown): Pick<AccountUsage, "windows"> {
	const root = body as Record<string, unknown> | undefined;
	const result: UsageWindow[] = [];
	const limits = Array.isArray(root?.limits) ? root.limits : [];
	for (const entry of limits) {
		const item = entry as Record<string, unknown> | undefined;
		const detail = (
			typeof item?.detail === "object" && item.detail !== null
				? item.detail
				: item
		) as Record<string, unknown>;
		const used = kimiPercent(detail);
		if (used === undefined) continue;
		const seconds = kimiWindowSeconds(item?.window);
		result.push({
			label: seconds === undefined ? "Limit" : durationLabel(seconds),
			used,
			resetsAt: toDate(detail.resetTime ?? detail.reset_at),
		});
	}
	const plan = root?.usage as Record<string, unknown> | undefined;
	if (plan) {
		const used = kimiPercent(plan);
		if (used !== undefined) {
			result.push({
				label: "7d",
				used,
				resetsAt: toDate(plan.resetTime ?? plan.reset_at),
			});
		}
	}
	return { windows: sortedWindows(result) };
}
