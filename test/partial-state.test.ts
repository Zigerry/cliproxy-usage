import assert from "node:assert/strict";
import test from "node:test";
import { applyProviderRead, beginProviderRead, deriveUsageSnapshot } from "../src/state.js";
import type { AccountUsage, ProviderUsageState } from "../src/types.js";

function item(incomplete = false): AccountUsage {
	return { provider: "codex", accountId: "a", label: "a", queried: true,
		windows: [{ label: "7d", used: 0, resetsAt: new Date(10_000) }], ...(incomplete ? { incomplete: true } : {}) };
}
function read(value: AccountUsage, previous?: ProviderUsageState, at = 100) {
	return applyProviderRead(previous, { provider: "codex", discovery: "success", items: [value] }, { attemptedAt: at, completedAt: at + 10 });
}
function snapshot(record: ProviderUsageState) {
	return deriveUsageSnapshot({ provider: "codex", enabled: true, configuration: { status: "ready" }, record,
		refreshing: false, now: 500, maxAgeMs: 60_000 });
}

test("one subset account advances its data time but not complete-data success", () => {
	const complete = read(item());
	const subset = read(item(true), complete, 200);
	assert.equal(subset.lastCompleteSuccessAt, 110);
	assert.equal(subset.accounts[0]?.valid?.at, 210);
	assert.equal(subset.accounts[0]?.valid?.data.incomplete, true);
	const value = snapshot(subset);
	assert.equal(value.state, "ready");
	assert.equal(value.partial, true);
	assert.equal(value.accounts[0]?.incomplete, true);
	assert.equal(value.accounts[0]?.windows[0]?.used, 0);
	assert.equal(read(item(true)).lastCompleteSuccessAt, undefined);
});

test("subset warning survives error/discovery fallback and clears on full recovery", () => {
	const subset = read(item(true));
	const failed = read({ ...item(), windows: [], error: "HTTP 503" }, subset, 200);
	for (const record of [failed, applyProviderRead(subset, { provider: "codex", discovery: "failure", error: "discovery failed" }, { attemptedAt: 200, completedAt: 210 })]) {
		const value = snapshot(record);
		assert.equal(value.partial, true);
		assert.equal(value.accounts[0]?.incomplete, true);
		assert.equal(value.accounts[0]?.cached, true);
		assert.equal(value.accounts[0]?.windows[0]?.used, 0);
	}
	const recovered = read(item(), failed, 300);
	assert.equal(recovered.lastCompleteSuccessAt, 310);
	assert.equal(snapshot(recovered).partial, false);
	assert.equal(snapshot(recovered).accounts[0]?.incomplete, undefined);
	assert.equal(recovered.accounts[0]?.valid?.data.incomplete, undefined);
});

test("latest unknown hides historical subset data, while current incompleteness remains explicit", () => {
	const subset = read(item(true));
	for (const incomplete of [false, true]) {
		const unknown = read({ ...item(incomplete), windows: [] }, subset, 200);
		const value = snapshot(unknown);
		assert.equal(value.state, "unknown");
		assert.deepEqual(value.accounts[0]?.windows, []);
		assert.equal(value.accounts[0]?.cached, false);
		assert.equal(value.accounts[0]?.incomplete, incomplete ? true : undefined);
		assert.equal(value.partial, incomplete);
		assert.equal(value.accounts[0]?.lastValidAt, 110);
		assert.equal(unknown.lastCompleteSuccessAt, undefined);
		const failed = read({ ...item(), windows: [], error: "HTTP 503" }, unknown, 300);
		assert.equal(snapshot(failed).accounts[0]?.incomplete, true);
	}
});

test("subset flags and nested data are detached across read, begin and snapshot clones", () => {
	const source = { ...item(true), balance: { available: true, amounts: [{ currency: "USD", amount: -1 }] } };
	const record = read(source);
	delete source.incomplete;
	source.windows[0]!.resetsAt!.setTime(1);
	source.balance.amounts[0]!.amount = 999;
	const begun = beginProviderRead(record, "codex", 200);
	delete record.accounts[0]!.incomplete;
	delete record.accounts[0]!.valid!.data.incomplete;
	assert.equal(begun.accounts[0]?.incomplete, true);
	assert.equal(begun.accounts[0]?.valid?.data.incomplete, true);
	const value = snapshot(begun);
	(value.accounts[0] as { incomplete?: true }).incomplete = undefined;
	(value.accounts[0]!.balance!.amounts[0] as { amount: number }).amount = 42;
	value.accounts[0]!.windows[0]!.resetsAt!.setTime(2);
	assert.equal(snapshot(begun).accounts[0]?.incomplete, true);
	assert.equal(snapshot(begun).accounts[0]?.balance?.amounts[0]?.amount, -1);
	assert.equal(snapshot(begun).accounts[0]?.windows[0]?.resetsAt?.getTime(), 10_000);
	assert.equal(record.accounts[0]?.valid?.data.windows[0]?.resetsAt?.getTime(), 10_000);
});

test("object-only unusable balances remain unknown/incomplete and empty discovery is complete", () => {
	const unknown = read({ ...item(true), windows: [], balance: { available: true, amounts: [] } });
	assert.equal(snapshot(unknown).state, "unknown");
	assert.equal(snapshot(unknown).partial, true);
	assert.equal(unknown.lastCompleteSuccessAt, undefined);
	const empty = applyProviderRead(unknown, { provider: "codex", discovery: "success", items: [] }, { attemptedAt: 200, completedAt: 210 });
	assert.equal(empty.lastCompleteSuccessAt, 210);
	assert.equal(snapshot(empty).partial, false);
});
