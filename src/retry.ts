import type { RefreshEligibility, RequestFailure, RetryState } from "./types.js";

const MAX_DATE = 8_640_000_000_000_000;
const LOCAL_CAP_MS = 60 * 60 * 1_000;

function future(deadline: number | undefined, now: number): number | undefined {
	return deadline !== undefined && Number.isFinite(deadline) && Math.abs(deadline) <= MAX_DATE && deadline > now
		? deadline : undefined;
}

function maximum(a: number | undefined, b: number | undefined): number | undefined {
	return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

function temporary(failure: RequestFailure): boolean {
	return failure.category === "rate-limit" || failure.category === "server"
		|| failure.category === "network" || failure.category === "timeout";
}

function localDelay(intervalMs: number, failures: number): number {
	if (!(intervalMs > 0)) return 0;
	const cap = Math.max(intervalMs, LOCAL_CAP_MS);
	let delay = intervalMs;
	let remaining = failures - 1;
	// Scale in finite chunks rather than evaluating an unbounded exponent.
	// Even the smallest positive JS number reaches the cap in at most three chunks.
	while (remaining > 0 && delay < cap) {
		const exponent = Math.min(remaining, 1_023);
		delay = Math.min(cap, delay * 2 ** exponent);
		remaining -= exponent;
	}
	return delay;
}

/** Apply one completed round; callers select actual requests of the appropriate scope. */
export function updateRetry(previous: RetryState | undefined,
	observation: { attempted: boolean; failures: readonly RequestFailure[]; complete?: boolean },
	now: number, intervalMs: number): RetryState | undefined {
	if (!observation.attempted) return previous ? { ...previous } : undefined;

	let serverUntil = future(previous?.serverUntil, now);
	let hasTemporary = false;
	for (const failure of observation.failures) {
		hasTemporary ||= temporary(failure);
		serverUntil = maximum(serverUntil, future(failure.retryAfterAt, now));
	}
	if (!hasTemporary) {
		if (observation.complete === false) return previous || serverUntil !== undefined ? {
			failures: previous?.failures ?? 0,
			...(previous?.backoffUntil !== undefined ? { backoffUntil: previous.backoffUntil } : {}),
			...(serverUntil !== undefined ? { serverUntil } : {}),
		} : undefined;
		return serverUntil === undefined ? undefined : { failures: 0, serverUntil };
	}

	const streak = previous?.failures ?? 0;
	const failures = Math.min(Number.MAX_SAFE_INTEGER,
		(Number.isFinite(streak) ? Math.max(0, Math.floor(streak)) : 0) + 1);
	const backoffUntil = Math.min(MAX_DATE, now + localDelay(intervalMs, failures));
	return { failures, backoffUntil, ...(serverUntil !== undefined ? { serverUntil } : {}) };
}

/** Detached future constraints, not a promise that a request will run at a deadline. */
export function deriveEligibility(source: RetryState | undefined, provider: RetryState | undefined,
	now: number, nextAutomaticCheckAt?: number): RefreshEligibility {
	const managementServerUntil = future(source?.serverUntil, now);
	const providerServerUntil = future(provider?.serverUntil, now);
	const backoffUntil = maximum(future(source?.backoffUntil, now), future(provider?.backoffUntil, now));
	const manualAllowedAt = maximum(managementServerUntil, providerServerUntil);
	const automaticAllowedAt = maximum(manualAllowedAt, backoffUntil);
	const nextCheck = future(nextAutomaticCheckAt, now);
	return {
		...(managementServerUntil !== undefined ? { managementServerUntil } : {}),
		...(providerServerUntil !== undefined ? { providerServerUntil } : {}),
		...(backoffUntil !== undefined ? { backoffUntil } : {}),
		...(manualAllowedAt !== undefined ? { manualAllowedAt } : {}),
		...(automaticAllowedAt !== undefined ? { automaticAllowedAt } : {}),
		...(nextCheck !== undefined ? { nextAutomaticCheckAt: nextCheck } : {}),
	};
}

/** Force bypasses local backoff only; the periodic check itself is not a gate. */
export function isEligible(eligibility: RefreshEligibility, force: boolean, now: number): boolean {
	return future(force ? eligibility.manualAllowedAt : eligibility.automaticAllowedAt, now) === undefined;
}
