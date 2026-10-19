import assert from "node:assert/strict";
import test from "node:test";
import {
	applyProviderRead,
	beginProviderRead,
	deriveUsageSnapshot,
	nextFreshnessDeadline,
	safeUsageText,
} from "../src/state.js";
import type {
	AccountUsage,
	ProviderUsageState,
	UsageConfiguration,
	UsageSnapshot,
} from "../src/types.js";

function item(kind: "valid" | "unknown" | "error" = "valid", accountId = "a"): AccountUsage {
	return {
		provider: "codex", accountId, label: accountId, queried: true,
		windows: kind === "valid" ? [{ label: "5h", used: 25 }] : [],
		...(kind === "error" ? { error: "request failed" } : {}),
	};
}

function read(items: AccountUsage[], previous?: ProviderUsageState, attemptedAt = 100, completedAt = 120) {
	return applyProviderRead(previous, { provider: "codex", discovery: "success", items }, { attemptedAt, completedAt });
}

function snapshot(record?: ProviderUsageState, options: Partial<Parameters<typeof deriveUsageSnapshot>[0]> = {}) {
	return deriveUsageSnapshot({
		provider: "codex", enabled: true, configuration: { status: "ready" },
		record, refreshing: false, now: 130, maxAgeMs: 100, ...options,
	});
}

function failure(previous?: ProviderUsageState) {
	return applyProviderRead(previous, { provider: "codex", discovery: "failure", error: "discovery failed" },
		{ attemptedAt: 200, completedAt: 220 });
}

test("initial idle/loading depends on actual work; refresh does not discard a retained outcome", () => {
	assert.equal(snapshot().state, "idle");
	assert.equal(snapshot(undefined, { refreshing: true }).state, "loading");
	const begun = beginProviderRead(undefined, "codex", 100);
	assert.equal(begun.lastAttemptAt, 100);
	assert.deepEqual(begun.accounts, []);
	assert.equal(snapshot(begun).state, "idle");
	assert.equal(snapshot(begun, { refreshing: true }).state, "loading");
	const current = snapshot(beginProviderRead(read([item()]), "codex", 200), { refreshing: true });
	assert.equal(current.state, "ready");
	assert.equal(current.refreshing, true);
	assert.equal(current.accounts[0]?.attemptedAt, 100);
	assert.equal(current.lastAttemptAt, 200);
});

test("account outcome matrix including empty, unknown+error and cached errors", () => {
	const cases: [Parameters<typeof item>[0][], UsageSnapshot["state"], boolean][] = [
		[[], "empty", false],
		[["valid"], "ready", false],
		[["valid", "valid"], "ready", false],
		[["valid", "error"], "ready", true],
		[["valid", "unknown"], "ready", true],
		[["valid", "error", "unknown"], "ready", true],
		[["unknown", "error"], "error", true],
		[["unknown"], "unknown", false],
		[["unknown", "unknown"], "unknown", false],
		[["error"], "error", false],
		[["error", "error"], "error", false],
	];
	for (const [kinds, state, partial] of cases) {
		const record = read(kinds.map((kind, i) => item(kind, String(i))));
		const value = snapshot(record);
		assert.equal(value.state, state, kinds.join("+") || "empty");
		assert.equal(snapshot(record, { refreshing: true }).state, state, "retained outcomes are not loading");
		assert.equal(value.partial, partial, kinds.join("+") || "empty");
		if (kinds.includes("error")) assert.match(value.error ?? "", /request failed/);
	}
	const cached = snapshot(read([item("error")], read([item()]), 125, 129));
	assert.equal(cached.state, "error");
	assert.equal(cached.partial, false);
	assert.equal(cached.accounts[0]?.cached, true);
	assert.equal(cached.accounts[0]?.stale, true);
});

test("configuration is typed, precedence is explicit, and disabled/unsupported hide accounts", () => {
	const record = read([item()]);
	const configuration: UsageConfiguration = { status: "setup-required", reason: "missing-key", message: "Set a key" };
	assert.equal(snapshot(record, { configuration }).state, "setup-required");
	assert.equal(snapshot(record, { configuration }).accounts[0]?.stale, true);
	assert.equal(snapshot(record, { configuration }).stale, true);
	const disabled = snapshot(record, { enabled: false, configuration });
	assert.equal(disabled.state, "disabled");
	assert.deepEqual(disabled.accounts, []);
	const unsupported = snapshot(record, { provider: undefined, enabled: false, configuration });
	assert.equal(unsupported.state, "unsupported");
	assert.deepEqual(unsupported.accounts, []);
	assert.equal(snapshot(undefined, { configuration: { status: "pending" } }).state, "idle");
	assert.equal(snapshot(undefined, { configuration: { status: "pending" }, refreshing: true }).state, "loading");
	const rejectedText = read([{ ...item("error"), error: "401 missing key invalid source" }]);
	assert.equal(snapshot(rejectedText).state, "error", "never infer setup by parsing errors");
	assert.equal(snapshot(undefined, { record: { ...record, provider: "claude" } }).state, "idle", "ignore a mismatched provider record");
});

test("attempt, last-valid and complete-success timestamps are separate", () => {
	const initial = read([item(), item("valid", "b")]);
	assert.equal(initial.lastAttemptAt, 100);
	assert.equal(initial.discovery?.at, 120);
	assert.equal(initial.lastCompleteSuccessAt, 120);
	const partial = read([item(), item("error", "b")], initial, 200, 240);
	assert.equal(partial.lastCompleteSuccessAt, 120);
	assert.equal(partial.accounts[0]?.valid?.at, 240);
	assert.equal(partial.accounts[1]?.valid?.at, 120);
	assert.deepEqual(partial.accounts.map((account) => account.attemptedAt), [200, 200]);
	const unknown = read([item("unknown")], partial, 300, 350);
	assert.equal(unknown.lastCompleteSuccessAt, 120);
	assert.equal(unknown.accounts[0]?.valid?.at, 240);
	assert.equal(read([], unknown, 400, 450).lastCompleteSuccessAt, 450);
	assert.equal(read([item("unknown")]).lastCompleteSuccessAt, undefined);
	assert.equal(read([item("error")]).lastCompleteSuccessAt, undefined);
});

test("begin read leaves previous account outcomes unchanged and detaches their data", () => {
	const previous = read([{ ...item(), windows: [{ label: "5h", used: 25, resetsAt: new Date(500) }],
		balance: { available: true, amounts: [{ currency: "USD", amount: 2 }] } }]);
	const begun = beginProviderRead(previous, "codex", 200);
	assert.deepEqual(begun.accounts, previous.accounts);
	assert.equal(previous.lastAttemptAt, 100);
	assert.equal(begun.accounts[0]?.attemptedAt, 100);
	previous.accounts[0]!.valid!.data.windows[0]!.resetsAt!.setTime(1);
	previous.accounts[0]!.valid!.data.balance!.amounts[0]!.amount = 999;
	previous.accounts.push(previous.accounts[0]!);
	assert.equal(begun.accounts.length, 1);
	assert.equal(begun.accounts[0]?.valid?.data.windows[0]?.resetsAt?.getTime(), 500);
	assert.equal(begun.accounts[0]?.valid?.data.balance?.amounts[0]?.amount, 2);
	assert.deepEqual(beginProviderRead(previous, "claude", 300).accounts, []);
});

test("only queried=true advances actual account attempts, including unavailable/new accounts", () => {
	const previous = read([item()]);
	for (const queried of [false, undefined]) {
		const result = read([{ ...item("error"), queried }, { ...item("error", "new"), queried }], previous, 200, 220);
		assert.equal(result.lastAttemptAt, 200);
		assert.equal(result.accounts[0]?.attemptedAt, 100);
		assert.equal(result.accounts[1]?.attemptedAt, undefined);
		assert.equal(result.accounts[0]?.queried, false);
	}
	const result = read([{ ...item("unknown"), queried: false }], previous, 200, 220);
	assert.equal(result.accounts[0]?.attemptedAt, 100);
	assert.equal(read([{ ...item(), queried: false }]).accounts[0]?.attemptedAt, undefined);
});

test("discovery failure preserves account query facts and marks retained values cached/stale", () => {
	const previous = read([item(), item("unknown", "b")]);
	const failed = failure(previous);
	assert.deepEqual(failed.accounts, previous.accounts);
	assert.equal(failed.lastAttemptAt, 200);
	assert.equal(failed.lastCompleteSuccessAt, undefined);
	assert.deepEqual(failed.discovery, { result: "error", at: 220, error: "discovery failed" });
	const value = snapshot(failed);
	assert.equal(value.state, "error");
	assert.equal(value.partial, false);
	assert.equal(value.accounts[0]?.cached, true);
	assert.equal(value.accounts[0]?.attemptedAt, 100);
	assert.equal(value.accounts[1]?.windows.length, 0);
	assert.equal(snapshot(failure(read([]))).state, "error");
	assert.equal(snapshot(failure()).state, "error");
	assert.equal(snapshot(failure()).stale, false, "without retained values there is no stale data");
	assert.equal(snapshot(read([item("error")])).accounts[0]?.stale, false);
	assert.equal(failure(read([item()])).lastCompleteSuccessAt, 120);
});

test("unknown retains historical metadata but never displays old quota or balance, then error can cache it", () => {
	const previous = read([{ ...item(), balance: { available: true, amounts: [{ currency: "USD", amount: -1 }] } }]);
	const unknown = read([item("unknown")], previous, 200, 220);
	const value = snapshot(unknown);
	assert.equal(value.state, "unknown");
	assert.deepEqual(value.accounts[0]?.windows, []);
	assert.equal(value.accounts[0]?.balance, undefined);
	assert.equal(value.accounts[0]?.lastValidAt, 120);
	assert.equal(value.accounts[0]?.cached, false);
	assert.equal(nextFreshnessDeadline(unknown, 130, 100), undefined);
	const failed = snapshot(read([item("error")], unknown, 300, 320));
	assert.equal(failed.accounts[0]?.windows[0]?.used, 25);
	assert.equal(failed.accounts[0]?.balance?.amounts[0]?.amount, -1);
	assert.equal(failed.accounts[0]?.lastValidAt, 120);
	assert.equal(failed.accounts[0]?.cached, true);
	assert.equal(failed.accounts[0]?.stale, true);
});

test("membership is replaced only after discovery; history matches stable IDs, never label or position", () => {
	const previous = read([item(), item("valid", "b")]);
	const renamed = read([{ ...item("error"), label: "renamed" }], previous);
	assert.equal(renamed.accounts.length, 1);
	assert.equal(renamed.accounts[0]?.valid?.at, 120);
	const replaced = read([{ ...item("error", "new"), label: "a" }], previous);
	assert.equal(replaced.accounts[0]?.valid, undefined);
	const anonymous = { ...item(), accountId: undefined };
	const unknown = read([{ ...anonymous, windows: [], error: "failed" }], read([anonymous]));
	assert.equal(unknown.accounts[0]?.valid, undefined);
	assert.equal(read([item("error", "b")], previous).accounts[0]?.valid?.at, 120);
	assert.equal(read([item("error")], { ...previous, provider: "claude" }).accounts[0]?.valid, undefined);
	assert.equal(read([item("error")], read([item(), item()])).accounts[0]?.valid, undefined, "ambiguous old IDs are not reliable");
});

test("opaque stable IDs retain exact whitespace and length across failed reads", () => {
	for (const id of [" id ", "x".repeat(300)]) {
		const previous = read([item("valid", id)]);
		const failed = snapshot(read([item("error", id)], previous));
		assert.equal(failed.accounts[0]?.accountId, id);
		assert.equal(failed.accounts[0]?.cached, true);
		assert.equal(failed.accounts[0]?.windows[0]?.used, 25);
	}
});

test("real zero quota and finite zero/negative balances are valid; nonfinite data is not", () => {
	for (const used of [0, 100]) {
		assert.equal(snapshot(read([{ ...item(), windows: [{ label: "5h", used }] }])).state, "ready");
	}
	for (const amount of [0, -5, 10]) {
		const value = snapshot(read([{ ...item(), windows: [], balance: { available: false, amounts: [{ currency: "USD", amount }] } }]));
		assert.equal(value.state, "ready");
		assert.equal(value.accounts[0]?.balance?.amounts[0]?.amount, amount);
	}
	for (const amount of [NaN, Infinity, -Infinity]) {
		const value = snapshot(read([{ ...item(), windows: [{ label: "5h", used: amount }],
			balance: { available: true, amounts: [{ currency: "USD", amount }] } }]));
		assert.equal(value.state, "unknown");
		assert.deepEqual(value.accounts[0]?.windows, []);
		assert.equal(value.accounts[0]?.balance, undefined);
	}
	assert.equal(snapshot(read([{ ...item(), windows: [], balance: { available: false, amounts: [] } }])).state, "unknown");
	const mixed = read([{ ...item(), windows: [{ label: "bad", used: NaN }, { label: "zero", used: 0 }],
		balance: { available: true, amounts: [{ currency: "USD", amount: Infinity }, { currency: "CNY", amount: 0 }] } }]);
	assert.deepEqual(mixed.accounts[0]?.valid?.data.windows, [{ label: "zero", used: 0 }]);
	assert.deepEqual(mixed.accounts[0]?.valid?.data.balance?.amounts, [{ currency: "CNY", amount: 0 }]);
});

test("age and reset expiry are inclusive boundaries and never change quota values", () => {
	const record = read([{ ...item(), windows: [{ label: "5h", used: 100, resetsAt: new Date(180) }] }]);
	assert.equal(snapshot(record, { now: 179 }).stale, false);
	assert.equal(snapshot(record, { now: 180 }).stale, true);
	assert.equal(snapshot(record, { now: 181 }).accounts[0]?.windows[0]?.used, 100);
	const noReset = read([item()]);
	assert.equal(snapshot(noReset, { now: 219 }).stale, false);
	assert.equal(snapshot(noReset, { now: 220 }).stale, true);
	assert.equal(snapshot(noReset, { now: 120, maxAgeMs: 0 }).stale, true);
	const invalidDate = read([{ ...item(), windows: [{ label: "5h", used: 25, resetsAt: new Date(NaN) }] }]);
	assert.equal(snapshot(invalidDate).stale, false);
	assert.equal(snapshot(invalidDate).accounts[0]?.windows[0]?.resetsAt, undefined);
});

test("freshness deadline selects only future boundaries on currently displayed fresh data", () => {
	assert.equal(nextFreshnessDeadline(undefined, 130, 100), undefined);
	const record = read([{ ...item(), windows: [
		{ label: "5h", used: 10, resetsAt: new Date(180) },
		{ label: "7d", used: 20, resetsAt: new Date(190) },
	] }]);
	assert.equal(nextFreshnessDeadline(record, 130, 100), 180);
	assert.equal(nextFreshnessDeadline(record, 180, 100), undefined);
	assert.equal(nextFreshnessDeadline(record, 230, 100), undefined);
	assert.equal(nextFreshnessDeadline(record, 130, 0), undefined);
	assert.equal(nextFreshnessDeadline(read([item()]), 130, 100), 220);
	assert.equal(nextFreshnessDeadline(read([item()]), 220, 100), undefined);
	assert.equal(nextFreshnessDeadline(failure(record), 130, 100), undefined);
	assert.equal(nextFreshnessDeadline(read([item("error")], record), 130, 100), undefined);
	const mixed = read([{ ...item(), windows: [{ label: "5h", used: 10, resetsAt: new Date(100) }] }, item("valid", "b")]);
	assert.equal(nextFreshnessDeadline(mixed, 130, 100), 220, "an already-stale account must not mask a fresh account");
	assert.equal(nextFreshnessDeadline(read([item(), item("error", "b")]), 130, 100), 220);
	const balance = read([{ ...item(), windows: [], balance: { available: true, amounts: [{ currency: "USD", amount: 0 }] } }]);
	assert.equal(nextFreshnessDeadline(balance, 130, 100), 220);
	assert.equal(nextFreshnessDeadline(read([]), 130, 100), undefined);
});

test("apply detaches caller data, prior facts and balance arrays in both directions", () => {
	const source = { ...item(), windows: [{ label: "5h", used: 25, resetsAt: new Date(500) }],
		balance: { available: true, amounts: [{ currency: "USD", amount: 2 }] } };
	const items = [source];
	const record = read(items);
	source.label = "mutated";
	source.windows[0]!.resetsAt.setTime(1);
	source.windows[0]!.used = 99;
	source.balance.amounts[0]!.amount = 99;
	items.length = 0;
	assert.equal(record.accounts[0]?.label, "a");
	assert.equal(record.accounts[0]?.valid?.data.windows[0]?.resetsAt?.getTime(), 500);
	assert.equal(record.accounts[0]?.valid?.data.balance?.amounts[0]?.amount, 2);
	const inherited = read([item("error")], record, 200, 220);
	record.accounts[0]!.valid!.data.windows[0]!.resetsAt!.setTime(2);
	record.accounts[0]!.valid!.data.balance!.amounts[0]!.amount = 88;
	assert.equal(inherited.accounts[0]?.valid?.data.windows[0]?.resetsAt?.getTime(), 500);
	assert.equal(inherited.accounts[0]?.valid?.data.balance?.amounts[0]?.amount, 2);
	const preserved = failure(inherited);
	preserved.accounts[0]!.valid!.data.balance!.amounts[0]!.amount = 77;
	assert.equal(inherited.accounts[0]?.valid?.data.balance?.amounts[0]?.amount, 2);
});

test("snapshot is a detached read model including dates, nested arrays and configuration", () => {
	const record = read([{ ...item(), windows: [{ label: "5h", used: 25, resetsAt: new Date(500) }],
		balance: { available: true, amounts: [{ currency: "USD", amount: 2 }] } }]);
	const configuration: UsageConfiguration = { status: "setup-required", reason: "rejected", message: "Set a key" };
	const first = snapshot(record, { configuration });
	configuration.message = "changed";
	assert.equal(first.configuration.status === "setup-required" && first.configuration.message, "Set a key");
	const mutable = first.accounts as unknown as AccountUsage[];
	mutable[0]!.windows[0]!.resetsAt!.setTime(1);
	mutable[0]!.windows.push({ label: "new", used: 100 });
	mutable[0]!.balance!.amounts[0]!.amount = 99;
	mutable.push(item());
	const again = snapshot(record);
	assert.equal(again.accounts.length, 1);
	assert.equal(again.accounts[0]?.windows.length, 1);
	assert.equal(again.accounts[0]?.windows[0]?.resetsAt?.getTime(), 500);
	assert.equal(again.accounts[0]?.balance?.amounts[0]?.amount, 2);
	record.accounts[0]!.valid!.data.windows[0]!.resetsAt!.setTime(2);
	assert.equal(again.accounts[0]?.windows[0]?.resetsAt?.getTime(), 500);
	assert.notEqual(first.accounts[0], again.accounts[0]);
});

test("safe text strips terminal escapes/controls, folds whitespace, redacts secrets before limiting", () => {
	assert.equal(safeUsageText("\x1b[31mred\x1b[0m\n\t text\x00\x07"), "red text");
	assert.equal(safeUsageText("\x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\"), "link");
	assert.equal(safeUsageText("before\u202Eafter\u009b31m!"), "beforeafter!");
	const secret = "private-management-credential";
	assert.equal(safeUsageText(`key ${secret}`, [secret]), "key [REDACTED]");
	const text = safeUsageText('Bearer abc.def.ghi access_token="super-secret" refresh_token=other-secret api_key: secret-value sk-abcdefghijklmno eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature');
	for (const token of ["abc.def.ghi", "super-secret", "other-secret", "secret-value", "sk-abcdefghijklmno", "eyJhbGciOiJIUzI1NiJ9"]) {
		assert.equal(text.includes(token), false, token);
	}
	assert.equal(Array.from(safeUsageText("🙂".repeat(300))).length, 240);
	assert.equal(safeUsageText("x".repeat(239) + secret, [secret]).includes(secret), false);
	assert.equal(safeUsageText("Bearer \x1b[31mtoken-secret\x1b[0m").includes("token-secret"), false);
});

test("safe text handles truncated escapes, quoted bearer values and repeated sanitization", () => {
	assert.equal(safeUsageText("safe\x1b]unfinished terminal payload"), "safe");
	assert.equal(safeUsageText("safe\x1bPunfinished terminal payload"), "safe");
	assert.equal(safeUsageText('Bearer "quoted-secret"').includes("quoted-secret"), false);
	const once = safeUsageText('Authorization: Bearer abc.def token="secret"');
	assert.equal(safeUsageText(once), once);
});

test("state and snapshot store safe labels/errors and never retain explicit secret redactions", () => {
	const secret = "private-management-credential";
	const result = applyProviderRead(undefined, { provider: "codex", discovery: "success", items: [
		{ ...item("error"), label: `\x1b[31mAccount ${secret}\x1b[0m`, error: `Failure ${secret} Bearer token-secret` },
	] }, { attemptedAt: 100, completedAt: 120 }, [secret]);
	assert.equal(JSON.stringify(result).includes(secret), false);
	assert.equal(result.accounts[0]?.label, "Account [REDACTED]");
	assert.equal(JSON.stringify(snapshot(result)).includes("token-secret"), false);
	const failed = applyProviderRead(read([item()]), { provider: "codex", discovery: "failure", error: `Oops ${secret}` },
		{ attemptedAt: 200, completedAt: 220 }, [secret]);
	assert.equal(JSON.stringify(failed).includes(secret), false);
	assert.equal(JSON.stringify(snapshot(failed)).includes(secret), false);
	const config = snapshot(undefined, { configuration: { status: "setup-required", reason: "rejected", message: "Bearer bad-token\nsetup" } });
	assert.equal(JSON.stringify(config).includes("bad-token"), false);
	const inherited = read([{ ...item(), label: secret }]);
	const cleaned = applyProviderRead(inherited, { provider: "codex", discovery: "failure", error: "failed" },
		{ attemptedAt: 200, completedAt: 220 }, [secret]);
	assert.equal(JSON.stringify(cleaned).includes(secret), false);
	const withExtraFields = {
		...item(), accountId: secret, rawBody: `do not retain ${secret}`,
		windows: [{ label: secret, used: 0 }],
		balance: { available: true, amounts: [{ currency: secret, amount: 0 }] },
	};
	const safe = applyProviderRead(undefined, { provider: "codex", discovery: "success", items: [withExtraFields] },
		{ attemptedAt: 100, completedAt: 120 }, [secret]);
	assert.equal(JSON.stringify(safe).includes(secret), false);
	assert.equal(JSON.stringify(safe).includes("rawBody"), false);
	assert.equal(safe.accounts[0]?.accountId, undefined);
	assert.equal(snapshot(safe).accounts[0]?.windows[0]?.used, 0);
});
