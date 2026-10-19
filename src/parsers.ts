import type { AccountUsage, UsageWindow } from "./types.js";

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function positiveNumber(value: unknown): number | undefined {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function validDate(value: string | number): Date | undefined {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function toDate(value: unknown): Date | undefined {
	if (typeof value === "string") return validDate(value);
	const raw = toNumber(value);
	return raw === undefined ? undefined : validDate(raw < 1e10 ? raw * 1000 : raw);
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
		seconds: positiveNumber(item?.limit_window_seconds),
		resetsAt:
			toDate(item?.reset_at) ??
			(resetAfter === undefined
				? undefined
				: validDate(Date.now() + resetAfter * 1000)),
	};
}

/** Only explicit durations prove a window's length; neither slot nor reset distance does. */
function codexLabel(window: UsageWindow & { seconds?: number }): string {
	return window.seconds === undefined ? "limit" : durationLabel(window.seconds);
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
	const used = toNumber(config?.creditUsagePercent);
	if (period?.type !== "USAGE_PERIOD_TYPE_WEEKLY" || used === undefined) {
		return { windows: [] };
	}
	return windows({
		label: "7d",
		used,
		resetsAt: toDate(period.end),
	});
}

function kimiPercent(detail: Record<string, unknown>): number | undefined {
	const limit = toNumber(detail.limit);
	const used = toNumber(detail.used);
	if (used !== undefined && limit !== undefined && limit > 0) {
		return toNumber((used / limit) * 100);
	}
	const remaining = toNumber(detail.remaining);
	if (remaining !== undefined && limit !== undefined && limit > 0) {
		return toNumber(((limit - remaining) / limit) * 100);
	}
	return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function kimiWindowSeconds(value: unknown): number | undefined {
	const item = record(value);
	const duration = positiveNumber(item?.duration);
	if (duration === undefined) return undefined;
	switch (item?.timeUnit) {
		case "TIME_UNIT_SECOND":
			return duration;
		case "TIME_UNIT_MINUTE":
			return positiveNumber(duration * 60);
		case "TIME_UNIT_HOUR":
			return positiveNumber(duration * 3600);
		case "TIME_UNIT_DAY":
			return positiveNumber(duration * 86400);
		case "TIME_UNIT_WEEK":
			return positiveNumber(duration * 604800);
		default:
			return undefined;
	}
}

export function parseKimi(body: unknown): Pick<AccountUsage, "windows"> {
	const root = record(body);
	const result: UsageWindow[] = [];
	const limits = Array.isArray(root?.limits) ? root.limits : [];
	for (const entry of limits) {
		const item = record(entry);
		if (!item) continue;
		const detail = record(item.detail) ?? item;
		const used = kimiPercent(detail);
		if (used === undefined) continue;
		const seconds = kimiWindowSeconds(item?.window);
		result.push({
			label: seconds === undefined ? "Limit" : durationLabel(seconds),
			used,
			resetsAt: toDate(detail.resetTime ?? detail.reset_at),
		});
	}
	const plan = record(root?.usage);
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
