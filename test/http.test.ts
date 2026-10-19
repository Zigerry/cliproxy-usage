import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfter } from "../src/http.js";

const now = Date.UTC(2026, 0, 1);

test("Retry-After accepts only nonnegative integer seconds and preserves long waits", () => {
	assert.equal(parseRetryAfter("15", now), now + 15_000);
	assert.equal(parseRetryAfter(" 0015\t", now), now + 15_000);
	assert.equal(parseRetryAfter("7000000", now), now + 7_000_000_000);
	assert.equal(parseRetryAfter("999999999999999999999999999999999999999999", now), 8.64e15);
	assert.equal(parseRetryAfter("8640000000000", 0), 8.64e15);
	for (const value of [null, undefined, "", "0", "-1", "+1", "1.5", "1e3", "Infinity", "NaN", "15 seconds", "0x10", "1, 2"]) {
		assert.equal(parseRetryAfter(value, now), undefined, String(value));
	}
});

test("Retry-After supports the three HTTP date forms, not liberal date parsing", () => {
	const at = Date.UTC(2026, 0, 2, 3, 4, 5);
	for (const value of ["Fri, 02 Jan 2026 03:04:05 GMT", "Friday, 02-Jan-26 03:04:05 GMT", "Fri Jan  2 03:04:05 2026"]) {
		assert.equal(parseRetryAfter(value, now), at, value);
	}
	for (const value of ["2026-01-02", "January 2 2026", "Fri, 02 Jan 2026 03:04:05 UTC", "Fri, 02 Jan 2026 03:04:05 GMT garbage", "Thu, 01 Jan 2026 00:00:00 GMT", "Wed, 01 Jan 2025 00:00:00 GMT"]) {
		assert.equal(parseRetryAfter(value, now), undefined, value);
	}
});

test("Retry-After dates must be calendar-valid, including leap years and time fields", () => {
	for (const value of ["Fri, 31 Feb 2026 03:04:05 GMT", "Sunday, 29-Feb-26 03:04:05 GMT", "Sun Feb 29 03:04:05 2026", "Fri, 02 Jan 2026 24:00:00 GMT", "Fri, 02 Jan 2026 03:60:05 GMT", "Fri, 02 Jan 2026 03:04:60 GMT", "Fri, 00 Jan 2026 03:04:05 GMT", "Fri, 02 Xxx 2026 03:04:05 GMT"]) {
		assert.equal(parseRetryAfter(value, now), undefined, value);
	}
	assert.equal(parseRetryAfter("Tue, 29 Feb 2028 03:04:05 GMT", now), Date.UTC(2028, 1, 29, 3, 4, 5));
	const ancient = new Date(0);
	ancient.setUTCFullYear(99, 0, 2);
	assert.equal(parseRetryAfter(ancient.toUTCString(), ancient.getTime() - 1000), ancient.getTime());
});

test("Retry-After rejects non-HTTP whitespace, invalid clocks and due limits", () => {
	for (const value of ["1\n", "\r1", "\u00a01", "Fri, 02 Jan 2026 03:04:05 GMT\n"]) assert.equal(parseRetryAfter(value, now), undefined, value);
	for (const clock of [NaN, Infinity, -Infinity, 8.64e15 + 1]) assert.equal(parseRetryAfter("1", clock), undefined);
	assert.equal(parseRetryAfter("1", 8.64e15), undefined);
	assert.equal(parseRetryAfter("8639999999999", 0), 8.64e15 - 1000);
	assert.equal(parseRetryAfter("8640000000000", now), 8.64e15);
});

test("obsolete two-digit years honor the fifty-year future rule across century boundaries", () => {
	const nextCentury = Date.UTC(2100, 0, 2, 3, 4, 5);
	assert.equal(parseRetryAfter("Saturday, 02-Jan-00 03:04:05 GMT", Date.UTC(2099, 0, 1)), nextCentury);
	assert.equal(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT", now), undefined);
	assert.equal(parseRetryAfter("Fri Jan 02 03:04:05 2026", now), Date.UTC(2026, 0, 2, 3, 4, 5));
});
