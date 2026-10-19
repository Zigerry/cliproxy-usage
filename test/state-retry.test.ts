import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderRead, beginProviderRead } from "../src/state.js";
import type { ProviderReadResult, ProviderUsageState, RetryState } from "../src/types.js";

const timing = { attemptedAt: 200, completedAt: 220 };
const results: ProviderReadResult[] = [
	{ provider: "codex", discovery: "failure", error: "discovery failed" },
	{ provider: "codex", discovery: "success", items: [] },
	{ provider: "codex", discovery: "success", items: [
		{ provider: "codex", accountId: "a", label: "account", queried: true, windows: [] },
	] },
	{ provider: "codex", discovery: "success", items: [
		{ provider: "codex", accountId: "a", label: "account", queried: true, windows: [], error: "failed" },
	] },
	{ provider: "codex", discovery: "success", items: [
		{ provider: "codex", accountId: "a", label: "account", queried: true,
			windows: [{ label: "5h", used: 20, resetsAt: new Date(900) }] },
	] },
];

function previous(retry: RetryState): ProviderUsageState {
	return {
		provider: "codex", accounts: [], lastAttemptAt: 100,
		discovery: { result: "success", at: 120 }, retry,
	};
}

test("begin preserves and detaches retry including a server-only record", () => {
	for (const retry of [
		{ failures: 3, backoffUntil: 5_000, serverUntil: 9_000 },
		{ failures: 0, serverUntil: 9_000 },
	]) {
		const old = previous(Object.freeze({ ...retry }));
		const begun = beginProviderRead(old, "codex", 200);
		assert.deepEqual(begun.retry, retry);
		assert.notEqual(begun.retry, old.retry);
		Object.assign(begun.retry!, { failures: 99, serverUntil: 1 });
		assert.deepEqual(old.retry, retry);
		assert.equal(old.lastAttemptAt, 100);
	}
});

test("apply preserves detached retry across discovery failures and valid/unknown/empty/error outcomes", () => {
	for (const retry of [
		{ failures: 3, backoffUntil: 5_000, serverUntil: 9_000 },
		{ failures: 0, serverUntil: 9_000 },
	]) {
		for (const result of results) {
			const old = previous(Object.freeze({ ...retry }));
			const applied = applyProviderRead(old, result, timing);
			assert.deepEqual(applied.retry, retry);
			assert.notEqual(applied.retry, old.retry);
			Object.assign(applied.retry!, { failures: 99, serverUntil: 1 });
			assert.deepEqual(old.retry, retry);
		}
	}
});

test("begin/apply chain detaches retry in both directions without dropping server-only retention", () => {
	const old = previous({ failures: 0, serverUntil: 9_000 });
	const begun = beginProviderRead(old, "codex", 200);
	const applied = applyProviderRead(begun, results[1]!, timing);
	assert.deepEqual(applied.retry, { failures: 0, serverUntil: 9_000 });
	assert.notEqual(applied.retry, begun.retry);
	Object.assign(old.retry!, { serverUntil: 10_000 });
	Object.assign(begun.retry!, { serverUntil: 11_000 });
	assert.equal(applied.retry?.serverUntil, 9_000);
	assert.equal(old.retry?.serverUntil, 10_000);
	assert.deepEqual(applied.accounts, []);
});

test("pure cloning neither invents retry nor transfers it between providers nor expires policy", () => {
	assert.equal(beginProviderRead(undefined, "codex", 200).retry, undefined);
	assert.equal(applyProviderRead(undefined, results[1]!, timing).retry, undefined);
	const old = previous({ failures: 2, backoffUntil: 1, serverUntil: 2 });
	assert.deepEqual(beginProviderRead(old, "codex", 200).retry, old.retry);
	assert.deepEqual(applyProviderRead(old, results[1]!, timing).retry, old.retry);
	assert.equal(beginProviderRead(old, "claude", 200).retry, undefined);
	assert.equal(applyProviderRead(old, { provider: "claude", discovery: "success", items: [] }, timing).retry, undefined);
});

test("retry preservation does not weaken deep cloning of account data", () => {
	const old = applyProviderRead(undefined, results[4]!, timing);
	old.retry = { failures: 1, backoffUntil: 5_000, serverUntil: 9_000 };
	for (const cloned of [beginProviderRead(old, "codex", 300), applyProviderRead(old, results[0]!, timing)]) {
		assert.notEqual(cloned.retry, old.retry);
		assert.deepEqual(cloned.retry, old.retry);
		assert.notEqual(cloned.accounts, old.accounts);
		assert.notEqual(cloned.accounts[0]?.valid?.data, old.accounts[0]?.valid?.data);
		cloned.accounts[0]!.valid!.data.windows[0]!.resetsAt!.setTime(1);
		Object.assign(cloned.retry!, { serverUntil: 10_000 });
		assert.equal(old.accounts[0]?.valid?.data.windows[0]?.resetsAt?.getTime(), 900);
		assert.equal(old.retry.serverUntil, 9_000);
	}
});

test("skipped discovery preserves prior actual facts and timestamps, with detached data", () => {
	const old = applyProviderRead(undefined, results[4]!, timing);
	old.retry = { failures: 1, backoffUntil: 5_000 };
	const skipped = applyProviderRead(old, { provider: "codex", discovery: "failure", attempted: false,
		error: "shared Management wait", failure: { scope: "management", category: "rate-limit", status: 429 } },
		{ attemptedAt: 300, completedAt: 320 });
	assert.deepEqual(skipped, old);
	assert.notEqual(skipped, old);
	skipped.accounts[0]!.valid!.data.windows[0]!.resetsAt!.setTime(1);
	assert.equal(old.accounts[0]?.valid?.data.windows[0]?.resetsAt?.getTime(), 900);
});
