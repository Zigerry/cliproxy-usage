import type { RequestFailure } from "./types.js";

const MAX_DATE = 8.64e15;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_DAY = "(Sun|Mon|Tue|Wed|Thu|Fri|Sat)";
const LONG_DAY = "(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)";
const MONTH = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
const TIME = "(\\d{2}):(\\d{2}):(\\d{2})";
const IMF = new RegExp(`^${SHORT_DAY}, (\\d{2}) ${MONTH} (\\d{4}) ${TIME} GMT$`);
const RFC850 = new RegExp(`^${LONG_DAY}, (\\d{2})-${MONTH}-(\\d{2}) ${TIME} GMT$`);
const ASCTIME = new RegExp(`^${SHORT_DAY} ${MONTH} ( [0-9]|[0-3]\\d) ${TIME} (\\d{4})$`);

/** Strict HTTP Retry-After parsing; only future, representable deadlines escape. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | undefined {
	if (typeof value !== "string" || !Number.isFinite(now) || Math.abs(now) > MAX_DATE) return undefined;
	const text = value.replace(/^[ \t]+|[ \t]+$/g, "");
	if (text.length > 0 && !/[^0-9]/.test(text)) {
		const seconds = Number(text);
		const at = Math.min(MAX_DATE, now + seconds * 1000);
		return at > now ? at : undefined;
	}
	let match = IMF.exec(text);
	let year: number;
	let month: number;
	let day: number;
	let hour: number;
	let minute: number;
	let second: number;
	let obsolete = false;
	if (match || (match = RFC850.exec(text))) {
		obsolete = match[4]!.length === 2;
		day = Number(match[2]);
		month = MONTHS.indexOf(match[3]!);
		year = Number(match[4]);
		if (obsolete) year += Math.floor((new Date(now).getUTCFullYear() + 50) / 100) * 100;
		hour = Number(match[5]);
		minute = Number(match[6]);
		second = Number(match[7]);
	} else if ((match = ASCTIME.exec(text))) {
		month = MONTHS.indexOf(match[2]!);
		day = Number(match[3]);
		hour = Number(match[4]);
		minute = Number(match[5]);
		second = Number(match[6]);
		year = Number(match[7]);
	} else return undefined;
	if (match[0] !== text) return undefined;
	const date = new Date(0);
	// setUTCFullYear avoids Date.UTC's special handling of years 00-99.
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, second, 0);
	if (obsolete) {
		const limit = new Date(now);
		limit.setUTCFullYear(limit.getUTCFullYear() + 50);
		if (date.getTime() > limit.getTime()) {
			year -= 100;
			date.setUTCFullYear(year, month, day);
		}
	}
	if (hour > 23 || minute > 59 || second > 59 || day < 1) return undefined;
	const at = date.getTime();
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return undefined;
	if (DAYS[date.getUTCDay()] !== match[1]!.slice(0, 3)) return undefined;
	return at > now ? at : undefined;
}

/** Safe facts only: never retain a response, header object, URL or arbitrary error. */
export class RequestError extends Error {
	constructor(public readonly failure: RequestFailure, message: string) {
		super(message);
		this.name = "RequestError";
	}
}

export function httpFailure(
	scope: RequestFailure["scope"],
	status: number,
	retryAfterAt?: number,
): RequestFailure {
	return {
		scope,
		category: status === 429 ? "rate-limit" : status === 401 || status === 403 ? "auth" : status >= 500 && status <= 599 ? "server" : "http",
		status,
		...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
	};
}

/** Nested Management headers are untrusted JSON, not HeadersInit. */
export function retryAfterFromRemoteHeaders(value: unknown, now: number): number | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	let latest: number | undefined;
	for (const [name, values] of Object.entries(value)) {
		if (name.toLowerCase() !== "retry-after") continue;
		for (const item of Array.isArray(values) ? values : [values]) {
			if (typeof item !== "string") continue;
			const at = parseRetryAfter(item, now);
			if (at !== undefined) latest = Math.max(latest ?? at, at);
		}
	}
	return latest;
}
