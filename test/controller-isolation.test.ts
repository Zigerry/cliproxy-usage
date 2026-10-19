import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";
import type { Settings } from "../src/types.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const account = (id: string | undefined, label: string) => ({ auth_index: id, provider: "codex", email: label });
const discovery = (files: unknown[]) => Response.json({ files });
const quota = (used: number) => Response.json({ status_code: 200, body: {
	rate_limit: { primary_window: { used_percent: used, limit_window_seconds: 604800 } },
} });
const failedQuota = () => Response.json({ status_code: 503 });

async function harness(t: TestContext) {
	const originalFetch = globalThis.fetch;
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-isolation-"));
	const paths = { settingsPath: join(dir, "settings.json"), legacySettingsPath: join(dir, "legacy.json"), providerConfigPath: join(dir, "provider.json") };
	let widget: unknown;
	let status: string | undefined;
	let publications = 0;
	const notifications: string[] = [];
	const theme = { fg: (_color: string, text: string) => text };
	const ui = {
		theme,
		setWidget: (_id: string, value: unknown) => { widget = value; publications++; },
		setStatus: (_id: string, value: string | undefined) => { status = value; },
		notify: (text: string) => { notifications.push(text); },
	};
	const ctx = { model: { provider: "cliproxyapi", id: "gpt-5" }, hasUI: true, mode: "tui", ui } as unknown as ExtensionContext;
	const controller = new UsageController(paths);
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.managementUrl = "https://first.example.invalid";
	settings.managementKey = "synthetic-one";
	const save = (value: Settings = settings) => writeFile(paths.settingsPath, JSON.stringify(value));
	await save();
	t.after(async () => {
		controller.shutdown(ctx);
		globalThis.fetch = originalFetch;
		await rm(dir, { recursive: true, force: true });
	});
	return {
		controller, ctx, settings, paths, save, notifications,
		get status() { return status; },
		get publications() { return publications; },
		loaded(value: Settings = settings): LoadedSettings {
			return { settings: structuredClone(value), raw: {}, path: paths.settingsPath, warnings: [], writable: true };
		},
		refresh: () => controller.refreshCurrent(ctx),
		render() {
			if (!widget) return "";
			const factory = widget as (tui: unknown, theme: typeof ui.theme) => { render(width: number): string[] };
			return factory(undefined, theme).render(240).join("\n");
		},
	};
}

test("stable account IDs preserve only the correct same-label cache and use new labels", async (t) => {
	const h = await harness(t);
	let phase = 0;
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/auth-files")) return discovery(phase === 0
			? [account("a", "same"), account("b", "same")]
			: [account("b", "renamed"), account("a", "same")]);
		const id = JSON.parse(String(init?.body)).auth_index;
		return phase && id === "b" ? failedQuota() : quota(id === "b" ? 70 : phase ? 40 : 20);
	};
	await h.refresh();
	phase = 1;
	await h.refresh();
	assert.match(h.render(), /renamed.*left 30%/);
	assert.match(h.render(), /same.*left 60%/);
});

test("successful discovery removes deleted accounts even when every remaining query fails", async (t) => {
	const h = await harness(t);
	let phase = 0;
	globalThis.fetch = async (input, init) => {
		if (String(input).endsWith("/auth-files")) return discovery(phase === 0
			? [account("a", "old-name"), account("b", "removed")]
			: [account("a", "kept")]);
		return phase ? failedQuota() : quota(JSON.parse(String(init?.body)).auth_index === "a" ? 20 : 70);
	};
	await h.refresh();
	const updated = h.controller.lastRefresh("codex")?.getTime();
	phase = 1;
	await h.refresh();
	assert.match(h.render(), /kept.*left 80%/);
	assert.doesNotMatch(h.render(), /removed|old-name/);
	assert.equal(h.controller.lastRefresh("codex")?.getTime(), updated);
});

test("discovery failure preserves the collection but malformed discovery cannot delete it", async (t) => {
	const h = await harness(t);
	let phase = 0;
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/auth-files")) {
			if (phase === 1) return new Response("", { status: 503 });
			if (phase === 2) return discovery([null]);
			if (phase === 3) return discovery([]);
			return discovery([account("a", "kept")]);
		}
		return quota(20);
	};
	await h.refresh();
	for (phase = 1; phase <= 2; phase++) {
		await h.refresh();
		assert.match(h.render(), /kept.*left 80%/);
	}
	await h.refresh();
	assert.equal(h.controller.getSnapshot(h.ctx).state, "empty");
	assert.deepEqual(h.controller.getSnapshot(h.ctx).accounts, []);
	assert.match(h.render(), /no accounts/);
});

test("missing IDs never reuse old quota and successful unknown responses replace old data", async (t) => {
	const h = await harness(t);
	let phase = 0;
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/auth-files")) return discovery([account(phase === 1 ? undefined : "a", "same")]);
		return phase === 2 ? Response.json({ status_code: 200, body: {} }) : quota(20);
	};
	await h.refresh();
	phase = 1;
	await h.refresh();
	assert.doesNotMatch(h.render(), /left 80%/);
	phase = 0;
	await h.refresh();
	phase = 2;
	await h.refresh();
	assert.doesNotMatch(h.render(), /left 80%/);
});

for (const change of ["url", "key", "inferred-url"] as const) {
	test(`source boundary change (${change}) prevents cross-source cache fallback`, async (t) => {
		const h = await harness(t);
		let phase = 0;
		const urls: string[] = [];
		if (change === "inferred-url") {
			h.settings.managementUrl = "";
			await h.save();
			await writeFile(h.paths.providerConfigPath, JSON.stringify({ baseUrl: "https://first.example.invalid/v1" }));
		}
		globalThis.fetch = async (input) => {
			urls.push(String(input));
			if (String(input).endsWith("/auth-files")) return discovery([account("a", "same")]);
			return phase ? failedQuota() : quota(20);
		};
		await h.refresh();
		phase = 1;
		if (change === "url") h.settings.managementUrl = "https://second.example.invalid";
		if (change === "key") h.settings.managementKey = "synthetic-two";
		await h.save();
		if (change === "inferred-url") await writeFile(h.paths.providerConfigPath, JSON.stringify({ baseUrl: "https://second.example.invalid/v1" }));
		await h.refresh();
		assert.doesNotMatch(h.render(), /left 80%/);
		if (change !== "key") assert.ok(urls.slice(2).every((url) => url.startsWith("https://second.example.invalid/")));
	});
}

for (const stage of ["discovery", "quota", "body"] as const) {
	test(`resetSettings cancels ${stage} work even if the mock ignores abort`, async (t) => {
		const h = await harness(t);
		const started = deferred<void>();
		const blockedFetch = deferred<Response>();
		const blockedBody = deferred<unknown>();
		let signal: AbortSignal | undefined;
		let block = true;
		globalThis.fetch = async (input, init) => {
			const isDiscovery = String(input).endsWith("/auth-files");
			if (block && ((stage === "discovery" && isDiscovery) || (stage !== "discovery" && !isDiscovery))) {
				signal = init?.signal ?? undefined;
				if (stage === "body") {
					const response = quota(99);
					response.json = () => { started.resolve(); return blockedBody.promise; };
					return response;
				}
				started.resolve();
				return blockedFetch.promise;
			}
			return isDiscovery ? discovery([account("a", "new")]) : quota(40);
		};
		let oldSettled = false;
		const old = h.controller.refreshCurrent(h.ctx, { notify: true }).then(() => { oldSettled = true; });
		await started.promise;
		// Actual logout path: persisted settings change, resetSettings, then repaint.
		h.settings.managementKey = "";
		await h.save();
		h.controller.resetSettings(h.settings, h.ctx);
		await flush();
		assert.equal(signal?.aborted, true);
		assert.equal(oldSettled, true);
		assert.equal(h.controller.getSnapshot(h.ctx).state, "setup-required");
		assert.deepEqual(h.controller.getSnapshot(h.ctx).accounts, []);
		assert.doesNotMatch(h.render(), /left \d+%/);
		block = false;
		h.settings.managementKey = "synthetic-two";
		await h.save();
		h.controller.resetSettings(h.settings, h.ctx);
		await h.refresh();
		assert.match(h.render(), /new.*left 60%/);
		const count = h.publications;
		blockedFetch.resolve(discovery([account("a", "old")]));
		blockedBody.reject(new Error("obsolete body"));
		// No body promise was consumed in the other two stages.
		if (stage !== "body") void blockedBody.promise.catch(() => {});
		await old;
		await flush();
		assert.equal(h.publications, count);
		assert.deepEqual(h.notifications, []);
	});
}

test("invalidated pending loaded settings and force requests settle without making HTTP calls", async (t) => {
	const h = await harness(t);
	const started = deferred<void>();
	const blocked = deferred<Response>();
	let blocking = true;
	let requests = 0;
	globalThis.fetch = async (input) => {
		requests++;
		if (blocking) { started.resolve(); return blocked.promise; }
		return String(input).endsWith("/auth-files") ? discovery([account("a", "new")]) : quota(40);
	};
	const first = h.refresh();
	await started.promise;
	let pendingSettled = false;
	const pending = h.controller.refreshCurrent(h.ctx, { force: true, notify: true, loaded: h.loaded() }).then(() => { pendingSettled = true; });
	h.settings.managementKey = "synthetic-two";
	await h.save();
	h.controller.resetSettings(h.settings, h.ctx);
	await flush();
	assert.equal(pendingSettled, true);
	assert.equal(requests, 1);
	blocking = false;
	await h.refresh();
	assert.equal(requests, 3);
	assert.match(h.render(), /left 60%/);
	blocked.reject(new Error("late rejected fetch"));
	await Promise.all([first, pending]);
	await flush();
	assert.deepEqual(h.notifications, []);
});

test("provider disable cannot be undone by an in-flight query", async (t) => {
	const h = await harness(t);
	const started = deferred<void>();
	const blocked = deferred<Response>();
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/auth-files")) return discovery([account("a", "old")]);
		started.resolve();
		return blocked.promise;
	};
	const old = h.refresh();
	await started.promise;
	h.settings.providers.codex = false;
	await h.save();
	await h.controller.applySettings(h.ctx, h.settings, "codex");
	blocked.resolve(quota(20));
	await old;
	h.controller.modelSelected(h.ctx, "codex");
	assert.equal(h.render(), "");
	assert.equal(h.controller.lastRefresh("codex"), undefined);
	assert.deepEqual(h.notifications, []);
});

test("obsolete work never accesses an expired host context after session restart", async (t) => {
	const h = await harness(t);
	const started = deferred<void>();
	const blocked = deferred<Response>();
	let expired = false;
	let phase = 0;
	const oldContext = new Proxy(h.ctx, {
		get(target, property, receiver) {
			if (expired) throw new Error("expired host context accessed");
			return Reflect.get(target, property, receiver);
		},
	});
	globalThis.fetch = async (input) => {
		if (phase === 0) { started.resolve(); return blocked.promise; }
		return String(input).endsWith("/auth-files") ? discovery([account("a", "new")]) : quota(40);
	};
	const old = h.controller.refreshCurrent(oldContext, { notify: true });
	await started.promise;
	h.controller.shutdown(oldContext);
	expired = true;
	phase = 1;
	h.controller.start(h.ctx, h.loaded());
	await h.refresh();
	blocked.reject(new Error("obsolete failure"));
	await old;
	await flush();
	assert.match(h.render(), /new.*left 60%/);
	assert.deepEqual(h.notifications, []);
});

test("old finally and rejected auth cannot clear or poison a restarted session", async (t) => {
	const h = await harness(t);
	const oldStarted = deferred<void>();
	const newStarted = deferred<void>();
	const oldResponse = deferred<Response>();
	const newResponse = deferred<Response>();
	let phase = 0;
	let newQueries = 0;
	globalThis.fetch = async (input) => {
		if (String(input).endsWith("/auth-files")) {
			if (phase === 0) { oldStarted.resolve(); return oldResponse.promise; }
			return discovery([account("a", "new")]);
		}
		newQueries++;
		newStarted.resolve();
		return newQueries === 1 ? newResponse.promise : quota(40);
	};
	const old = h.refresh();
	await oldStarted.promise;
	h.controller.shutdown(h.ctx);
	phase = 1;
	h.controller.start(h.ctx, h.loaded());
	await newStarted.promise;
	assert.match(h.status ?? "", /refreshing/);
	oldResponse.resolve(new Response("", { status: 401 }));
	await old;
	await flush();
	assert.match(h.status ?? "", /refreshing/);
	newResponse.resolve(quota(40));
	await flush();
	assert.match(h.render(), /new.*left 60%/);
	assert.equal(h.status, undefined);
	await h.refresh();
	assert.equal(newQueries, 2);
	assert.match(h.render(), /left 60%/);
	assert.deepEqual(h.notifications, []);
});
