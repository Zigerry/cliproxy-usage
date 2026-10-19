import assert from "node:assert/strict";
import test from "node:test";
import { deriveEligibility, isEligible, updateRetry } from "../src/retry.js";
import type { RefreshEligibility, RequestFailure, RetryState } from "../src/types.js";

const NOW = 1_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_DATE = 8_640_000_000_000_000;
const temporary: RequestFailure["category"][] = ["rate-limit", "server", "network", "timeout"];
const permanent: RequestFailure["category"][] = ["auth", "http", "invalid-response"];
const failure = (category: RequestFailure["category"], retryAfterAt?: number): RequestFailure => ({
	scope: "provider", category, ...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
});
const observe = (failures: readonly RequestFailure[] = [], attempted = true) => ({ attempted, failures });

test("no actual attempt returns detached previous facts unchanged, even if expired or failures were supplied", () => {
	assert.equal(updateRetry(undefined, observe([failure("server", 9_000)], false), NOW, MINUTE), undefined);
	const previous = Object.freeze({ failures: 3, backoffUntil: 100, serverUntil: 200 });
	const result = updateRetry(previous, observe([failure("rate-limit", 9_000)], false), NOW, MINUTE);
	assert.deepEqual(result, previous);
	assert.notEqual(result, previous);
});

test("each temporary category starts at the interval; scope filtering belongs to the caller", () => {
	for (const category of temporary) {
		for (const scope of ["management", "provider"] as const) {
			assert.deepEqual(updateRetry(undefined, observe([{ scope, category }]), NOW, MINUTE), {
				failures: 1, backoffUntil: NOW + MINUTE,
			});
		}
	}
	for (const category of permanent) {
		assert.equal(updateRetry(undefined, observe([failure(category)]), NOW, MINUTE), undefined);
	}
});

test("streak increments once per round, including many accounts and partial successes", () => {
	const failures = Object.freeze(Array.from({ length: 1_000 }, (_, i) =>
		Object.freeze(failure(temporary[i % temporary.length]!))));
	const observation = Object.freeze(observe(failures));
	const first = updateRetry(undefined, observation, NOW, MINUTE)!;
	assert.deepEqual(first, { failures: 1, backoffUntil: NOW + MINUTE });
	const second = updateRetry(first, observation, NOW + 20, MINUTE)!;
	assert.deepEqual(second, { failures: 2, backoffUntil: NOW + 20 + 2 * MINUTE });
	assert.deepEqual(first, { failures: 1, backoffUntil: NOW + MINUTE });
	assert.deepEqual(updateRetry(first, observe([failure("auth"), failure("network")]), NOW, MINUTE), {
		failures: 2, backoffUntil: NOW + 2 * MINUTE,
	}, "a sibling success/nontransient outcome must not erase a temporary failure");
	assert.equal(observation.failures, failures);
	assert.equal(failures.length, 1_000);
});

test("local delay doubles each round and strictly caps at max(interval, one hour)", () => {
	let previous: RetryState | undefined;
	for (let round = 1; round <= 80; round++) {
		previous = updateRetry(previous, observe([failure("network")]), NOW, MINUTE)!;
		assert.equal(previous.failures, round);
		assert.equal(previous.backoffUntil, NOW + Math.min(HOUR, MINUTE * 2 ** (round - 1)));
	}
	for (const interval of [7 * MINUTE, HOUR, 2 * HOUR, 25 * HOUR]) {
		for (const failures of [0, 1, 2, 100, Number.MAX_SAFE_INTEGER]) {
			const result = updateRetry({ failures }, observe([failure("timeout")]), NOW, interval)!;
			assert.equal(result.backoffUntil, NOW + Math.min(Math.max(interval, HOUR), interval * 2 ** failures));
		}
	}
});

test("failure counts saturate and extreme intervals/deadlines cannot overflow Date time", () => {
	for (const count of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
		const result = updateRetry({ failures: count }, observe([failure("network")]), NOW, MINUTE)!;
		assert.equal(result.failures, Number.MAX_SAFE_INTEGER);
		assert.equal(result.backoffUntil, NOW + HOUR);
	}
	assert.equal(updateRetry(undefined, observe([failure("server")]), MAX_DATE - 10, MINUTE)?.backoffUntil, MAX_DATE);
	assert.equal(updateRetry({ failures: 1_000 }, observe([failure("server")]), NOW, Number.MAX_VALUE)?.backoffUntil, MAX_DATE);
	assert.equal(updateRetry({ failures: 1_000 }, observe([failure("server")]), NOW, Number.MIN_VALUE)?.backoffUntil,
		NOW + Number.MIN_VALUE * 2 ** 1_000);
});

test("completed success, unknown/empty, and nontransient rounds reset only local streak/backoff", () => {
	const local = Object.freeze({ failures: 5, backoffUntil: NOW + HOUR });
	const waiting = Object.freeze({ ...local, serverUntil: NOW + 2 * HOUR });
	for (const failures of [[], ...permanent.map((category) => [failure(category)])]) {
		assert.equal(updateRetry(local, observe(failures), NOW, MINUTE), undefined);
		assert.deepEqual(updateRetry(waiting, observe(failures), NOW, MINUTE), {
			failures: 0, serverUntil: NOW + 2 * HOUR,
		});
	}
	assert.deepEqual(local, { failures: 5, backoffUntil: NOW + HOUR });
	assert.deepEqual(updateRetry(waiting, observe(), NOW, 1), { failures: 0, serverUntil: NOW + 2 * HOUR },
		"interval changes cannot shorten a server wait");
});

test("server wait takes same-round maximum independently of category, scope, status or response order", () => {
	const failures = [
		failure("network", NOW + MINUTE),
		{ ...failure("http", NOW + 5 * HOUR), status: 503 },
		{ ...failure("auth", NOW + HOUR), scope: "management" as const },
		failure("invalid-response", NOW + 2 * HOUR),
	];
	const previous = Object.freeze({ failures: 2, serverUntil: NOW + 3 * HOUR });
	const result = updateRetry(previous, observe(failures), NOW, MINUTE);
	assert.deepEqual(result, { failures: 3, backoffUntil: NOW + 4 * MINUTE, serverUntil: NOW + 5 * HOUR });
	assert.deepEqual(updateRetry(previous, observe([...failures].reverse()), NOW, MINUTE), result);
	assert.deepEqual(updateRetry(previous, observe([failure("http", NOW + MINUTE)]), NOW, MINUTE), {
		failures: 0, serverUntil: NOW + 3 * HOUR,
	});
	assert.deepEqual(updateRetry(undefined, observe([failure("http", MAX_DATE)]), NOW, MINUTE), {
		failures: 0, serverUntil: MAX_DATE,
	}, "server waits are never capped by local backoff policy");
});

test("only valid, strictly future server timestamps survive attempted updates", () => {
	for (const deadline of [NOW - 1, NOW, NaN, Infinity, -Infinity, MAX_DATE + 1, -MAX_DATE - 1]) {
		assert.equal(updateRetry({ failures: 0, serverUntil: deadline }, observe([failure("http", deadline)]), NOW, MINUTE), undefined);
	}
	const server = updateRetry(undefined, observe([failure("http", NOW + 1)]), NOW, MINUTE)!;
	assert.deepEqual(updateRetry(server, observe(), NOW, MINUTE), server);
	assert.equal(updateRetry(server, observe(), NOW + 1, MINUTE), undefined);
	assert.deepEqual(updateRetry({ failures: 9, serverUntil: NOW }, observe([failure("server")]), NOW, MINUTE), {
		failures: 10, backoffUntil: NOW + HOUR,
	});
});

test("eligibility separates source/provider server waits, local backoff and an actual tick", () => {
	const source = Object.freeze({ failures: 2, backoffUntil: 9_000, serverUntil: 4_000 });
	const provider = Object.freeze({ failures: 1, backoffUntil: 7_000, serverUntil: 6_000 });
	assert.deepEqual(deriveEligibility(source, provider, NOW, 2_000), {
		managementServerUntil: 4_000, providerServerUntil: 6_000,
		backoffUntil: 9_000, manualAllowedAt: 6_000, automaticAllowedAt: 9_000,
		nextAutomaticCheckAt: 2_000,
	}, "an actual tick may precede eligibility; do not promise a retry then");
	assert.deepEqual(deriveEligibility(provider, source, NOW), {
		managementServerUntil: 6_000, providerServerUntil: 4_000,
		backoffUntil: 9_000, manualAllowedAt: 6_000, automaticAllowedAt: 9_000,
	});
	assert.deepEqual(deriveEligibility(undefined, undefined, NOW), {});
	assert.deepEqual(deriveEligibility(undefined, { failures: 1, backoffUntil: 7_000 }, NOW), {
		backoffUntil: 7_000, automaticAllowedAt: 7_000,
	});
	assert.deepEqual(deriveEligibility({ failures: 0, serverUntil: 7_000 }, undefined, NOW), {
		managementServerUntil: 7_000, manualAllowedAt: 7_000, automaticAllowedAt: 7_000,
	});
});

test("eligibility removes due/invalid deadlines and never fabricates an automatic schedule", () => {
	for (const deadline of [NOW - 1, NOW, NaN, Infinity, -Infinity, MAX_DATE + 1, -MAX_DATE - 1]) {
		const record = { failures: 5, serverUntil: deadline, backoffUntil: deadline };
		assert.deepEqual(deriveEligibility(record, record, NOW, deadline), {});
	}
	const record = Object.freeze({ failures: 1, serverUntil: 2_000, backoffUntil: 3_000 });
	assert.deepEqual(deriveEligibility(record, undefined, 3_000), {});
	assert.deepEqual(deriveEligibility(undefined, undefined, NOW, MAX_DATE), { nextAutomaticCheckAt: MAX_DATE });
	const first = deriveEligibility(record, undefined, NOW);
	const again = deriveEligibility(record, undefined, NOW);
	assert.notEqual(first, again);
	Object.assign(first, { automaticAllowedAt: 1 });
	assert.equal(again.automaticAllowedAt, 3_000);
	assert.equal(record.backoffUntil, 3_000);
});

test("force bypasses only local backoff, with inclusive expiry and no tick-based blocking", () => {
	const eligibility = deriveEligibility({ failures: 1, serverUntil: 2_000 }, {
		failures: 2, backoffUntil: 3_000,
	}, NOW, 10_000);
	for (const now of [NOW, 1_999]) {
		assert.equal(isEligible(eligibility, true, now), false);
		assert.equal(isEligible(eligibility, false, now), false);
	}
	assert.equal(isEligible(eligibility, true, 2_000), true);
	assert.equal(isEligible(eligibility, false, 2_000), false);
	assert.equal(isEligible(eligibility, false, 2_999), false);
	assert.equal(isEligible(eligibility, false, 3_000), true);
	assert.equal(isEligible({ nextAutomaticCheckAt: 10_000 }, false, NOW), true);
	for (const force of [true, false]) assert.equal(isEligible({}, force, NOW), true);
	const local: RefreshEligibility = deriveEligibility(undefined, { failures: 1, backoffUntil: 3_000 }, NOW);
	assert.equal(isEligible(local, true, NOW), true);
	assert.equal(isEligible(local, false, NOW), false);
});

test("incomplete actual rounds preserve local streak but still collect server instructions", () => {
	const previous = { failures: 2, backoffUntil: NOW + 4 * MINUTE };
	assert.deepEqual(updateRetry(previous, { attempted: true, complete: false, failures: [] }, NOW, MINUTE), previous);
	assert.deepEqual(updateRetry(previous, { attempted: true, complete: false, failures: [failure("auth", NOW + HOUR)] }, NOW, MINUTE), {
		...previous, serverUntil: NOW + HOUR,
	});
	assert.deepEqual(updateRetry(previous, { attempted: true, complete: false, failures: [failure("server")] }, NOW, MINUTE), {
		failures: 3, backoffUntil: NOW + 4 * MINUTE,
	});
	assert.equal(updateRetry(undefined, { attempted: true, complete: false, failures: [] }, NOW, MINUTE), undefined);
});
