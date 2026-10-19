import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { UsageController } from "../src/controller.js";
import { DEFAULT_SETTINGS, type LoadedSettings } from "../src/settings.js";
import type { ProviderName } from "../src/types.js";

const START = Date.UTC(2030, 0, 1);
type Phase =
	| "valid"
	| "management-wait"
	| "management-local"
	| "provider-wait"
	| "provider-local"
	| "unknown"
	| "partial"
	| "auth";

async function harness(t: TestContext) {
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-retry-"));
	const paths = {
		settingsPath: join(dir, "settings.json"),
		legacySettingsPath: join(dir, "legacy.json"),
		providerConfigPath: join(dir, "provider.json"),
	};
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.managementKey = "synthetic-only";
	settings.managementUrl = "https://management.example.invalid";
	const save = () => writeFile(paths.settingsPath, JSON.stringify(settings));
	await save();
	let model = { provider: "cliproxyapi", id: "gpt-5" };
	let phase: Phase = "valid";
	const requests: string[] = [];
	const notices: string[] = [];
	let widget: unknown;
	let publications = 0;
	let detail: {
		handleInput(input: string): void;
		dispose(): void;
		render(width: number): string[];
	} | undefined;
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		get model() {
			return model;
		},
		hasUI: true,
		mode: "tui",
		ui: {
			theme,
			setWidget(_id: string, value: unknown) {
				widget = value;
				publications++;
			},
			setStatus() {},
			notify(message: string) {
				notices.push(message);
			},
			custom: (factory: (...args: any[]) => any) => new Promise<void>((resolve) => {
				detail = factory(
					{ terminal: { rows: 24 }, requestRender() {} },
					theme,
					{},
					() => {
						detail?.dispose();
						resolve();
					},
				);
			}),
		},
	} as unknown as ExtensionCommandContext;
	const reply = (input: unknown, init?: RequestInit): Response => {
		const url = String(input);
		if (url.endsWith("/auth-files")) {
			if (phase === "management-wait") {
				return new Response("", { status: 429, headers: { "Retry-After": "600" } });
			}
			if (phase === "management-local") {
				return new Response("", { status: 429 });
			}
			if (phase === "auth") {
				return new Response("", { status: 401 });
			}
			return Response.json({
				files: ["codex", "claude"].flatMap((provider) => ["a", "b"].map((id) => ({
					provider,
					auth_index: `${provider}-${id}`,
				}))),
			});
		}
		const id = JSON.parse(String(init?.body)).auth_index as string;
		if (phase === "provider-wait" && id.startsWith("codex")) {
			return Response.json({
				status_code: 429,
				header: { "rEtRy-AfTeR": id.endsWith("a") ? "90" : "600" },
			});
		}
		if ((phase === "provider-local" || phase === "partial" && id.endsWith("b")) && id.startsWith("codex")) {
			return Response.json({ status_code: 503 });
		}
		if (phase === "unknown") {
			return Response.json({ status_code: 200, body: {} });
		}
		return Response.json({
			status_code: 200,
			body: id.startsWith("codex")
				? {
					rate_limit: {
						primary_window: {
							used_percent: 20,
							limit_window_seconds: 604800,
						},
					},
				}
				: { seven_day: { utilization: 20 } },
		});
	};
	let handler: (input: unknown, init?: RequestInit) => Response | Promise<Response> = reply;
	t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
		requests.push(String(input));
		return handler(input, init);
	});
	const controller = new UsageController(paths);
	t.after(async () => {
		controller.shutdown(ctx);
		await rm(dir, { recursive: true, force: true });
	});
	const loaded = (): LoadedSettings => ({
		settings: structuredClone(settings),
		raw: {},
		path: paths.settingsPath,
		writable: true,
		warnings: [],
	});
	// An explicit non-force queue barrier, not a wall-clock polling loop. All uses
	// with exact request-count assertions are already behind a known server gate.
	const idle = () => controller.refreshCurrent(ctx, { loaded: loaded() });
	return {
		controller,
		ctx,
		settings,
		paths,
		save,
		loaded,
		requests,
		notices,
		reply,
		idle,
		get phase() {
			return phase;
		},
		set phase(value: Phase) {
			phase = value;
		},
		set handler(value: typeof handler) {
			handler = value;
		},
		refresh: (force = false) => controller.refreshCurrent(ctx, { force, loaded: loaded() }),
		snapshot: () => controller.getSnapshot(ctx),
		async select(provider: ProviderName) {
			model = { provider: "cliproxyapi", id: provider === "codex" ? "gpt-5" : `${provider}-4` };
			controller.modelSelected(ctx, provider);
			await idle();
		},
		get publications() {
			return publications;
		},
		unsupported() {
			model = { provider: "cliproxyapi", id: "o3" };
			controller.modelSelected(ctx, undefined);
		},
		detail: () => detail,
		render() {
			return widget ? (widget as any)(undefined, theme).render(240).join("\n") : "";
		},
	};
}

for (const phase of ["management-wait", "management-local"] as const) {
	test(`${phase} gates cross-provider automatic triggers; only explicit server wait blocks force`, async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: START });
		const h = await harness(t);
		h.phase = phase;
		await h.refresh();
		const count = h.requests.length;
		const before = h.snapshot().lastAttemptAt;
		const expected = START + (phase === "management-wait" ? 600_000 : 300_000);
		assert.equal(h.snapshot().eligibility?.automaticAllowedAt, expected);
		for (let i = 0; i < 8; i++) {
			await h.refresh();
		}
		await h.select("claude");
		await h.refresh();
		assert.equal(h.requests.length, count);
		assert.equal(h.snapshot().lastAttemptAt, undefined);
		if (phase === "management-wait") {
			await h.refresh(true);
			assert.equal(h.requests.length, count);
		} else {
			await h.refresh(true);
			assert.ok(h.requests.length > count);
		}
		await h.select("codex");
		assert.equal(h.snapshot().lastAttemptAt, before);
	});
}

test("provider wait is isolated, takes maximum deadline and survives disable/re-enable", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	h.phase = "provider-wait";
	await h.refresh();
	const count = h.requests.length;
	assert.equal(h.snapshot().eligibility?.providerServerUntil, START + 600_000);
	await h.refresh(true);
	assert.equal(h.requests.length, count);
	h.phase = "valid";
	await h.select("claude");
	assert.ok(h.requests.length > count);
	assert.equal(h.snapshot().state, "ready");
	await h.select("codex");
	const before = h.requests.length;
	h.settings.providers.codex = false;
	await h.save();
	await h.controller.applySettings(h.ctx, h.settings, "codex");
	assert.equal(h.snapshot().state, "disabled");
	h.settings.providers.codex = true;
	await h.save();
	await h.controller.applySettings(h.ctx, h.settings, "codex");
	await h.refresh(true);
	assert.equal(h.requests.length, before);
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
});

test("partial transient rounds back off once, force bypasses local and unknown resets it", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	h.phase = "partial";
	await h.refresh();
	assert.equal(h.snapshot().partial, true);
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, START + 300_000);
	const attempts = h.requests.length;
	await h.refresh();
	assert.equal(h.requests.length, attempts);
	assert.equal(h.snapshot().lastCompleteSuccessAt, undefined);
	await h.refresh(true);
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, START + 600_000);
	h.phase = "unknown";
	await h.refresh(true);
	assert.equal(h.snapshot().state, "unknown");
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, undefined);
	assert.equal(h.snapshot().lastCompleteSuccessAt, undefined);
	h.phase = "provider-local";
	await h.refresh();
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, START + 300_000);
	h.phase = "valid";
	await h.refresh(true);
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, undefined);
	assert.equal(h.snapshot().lastCompleteSuccessAt, START);
});

test("pending force is gated at execution after newly received Management limit", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	let release!: (response: Response) => void;
	const blocked = new Promise<Response>((resolve) => {
		release = resolve;
	});
	let enter!: () => void;
	const entered = new Promise<void>((resolve) => {
		enter = resolve;
	});
	h.handler = async (input, init) => {
		if (String(input).endsWith("/auth-files")) {
			enter();
			return blocked;
		}
		return h.reply(input, init);
	};
	const first = h.refresh();
	await entered;
	const second = h.refresh(true);
	const third = h.refresh(true);
	release(new Response("", { status: 429, headers: { "Retry-After": "600" } }));
	await Promise.all([first, second, third]);
	assert.equal(h.requests.length, 1);
	assert.equal(h.snapshot().refreshing, false);
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, START + 600_000);
});

test("details opening and r both obey server wait without changing account times", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	await h.refresh();
	h.phase = "provider-wait";
	await h.refresh(true);
	const before = h.snapshot();
	const count = h.requests.length;
	const view = h.controller.showDetails(h.ctx);
	await h.idle();
	h.detail()?.handleInput("r");
	await h.idle();
	assert.equal(h.requests.length, count);
	assert.equal(h.snapshot().lastAttemptAt, before.lastAttemptAt);
	assert.equal(h.snapshot().accounts[0]?.lastValidAt, before.accounts[0]?.lastValidAt);
	assert.match(h.detail()?.render(160).join("\n") ?? "", /server wait|server.*until|allowed/i);
	h.detail()?.handleInput("\u001b");
	await view;
});

test("source and key changes discard old waits while interval change cannot shorten them", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	h.phase = "management-wait";
	await h.refresh();
	const count = h.requests.length;
	h.settings.refreshMinutes = 1;
	await h.save();
	await h.controller.applySettings(h.ctx, h.settings, "refreshMinutes");
	await h.refresh(true);
	assert.equal(h.requests.length, count);
	h.phase = "valid";
	h.settings.managementUrl = "https://second.example.invalid";
	await h.save();
	await h.refresh();
	assert.equal(h.snapshot().state, "ready");
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, undefined);
	h.phase = "management-wait";
	await h.refresh(true);
	h.settings.managementKey = "changed-synthetic";
	await h.save();
	h.phase = "valid";
	await h.refresh();
	assert.equal(h.snapshot().state, "ready");
});

test("eligibility expiry only repaints; no fabricated automatic schedule", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
	const h = await harness(t);
	h.phase = "provider-wait";
	await h.refresh();
	assert.equal(h.snapshot().eligibility?.nextAutomaticCheckAt, undefined);
	const count = h.requests.length;
	const publications = h.publications;
	t.mock.timers.tick(600_000);
	assert.ok(h.publications > publications);
	assert.equal(h.requests.length, count);
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, undefined);
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, undefined);
	const after = h.publications;
	t.mock.timers.tick(60_000);
	assert.equal(h.publications, after);
});

test("periodic next check is distinct from allowed time and stops with unsupported model/shutdown", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
	const h = await harness(t);
	h.phase = "management-wait";
	h.controller.start(h.ctx, h.loaded());
	await h.idle();
	assert.equal(h.snapshot().eligibility?.nextAutomaticCheckAt, START + 300_000);
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, START + 600_000);
	const count = h.requests.length;
	t.mock.timers.tick(300_000);
	await h.idle();
	assert.equal(h.requests.length, count);
	assert.equal(h.snapshot().eligibility?.nextAutomaticCheckAt, START + 600_000);
	await h.controller.showStatus(h.ctx);
	assert.match(h.notices.at(-1) ?? "", /Next automatic check:/);
	assert.match(h.notices.at(-1) ?? "", /Earliest automatic request:/);
	h.unsupported();
	assert.equal(h.snapshot().eligibility?.nextAutomaticCheckAt, undefined);
	h.controller.shutdown(h.ctx);
	const publications = h.publications;
	t.mock.timers.tick(3_600_000);
	assert.equal(h.publications, publications);
	assert.equal(h.requests.length, count);
});

test("status is read-only and explains local force allowance, no automatic plan without start", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	h.phase = "provider-local";
	await h.refresh();
	const count = h.requests.length;
	await h.controller.showStatus(h.ctx);
	assert.equal(h.requests.length, count);
	assert.match(h.notices.at(-1) ?? "", /Earliest automatic request:/);
	assert.match(h.notices.at(-1) ?? "", /manual.*now|force.*local/i);
	assert.match(h.notices.at(-1) ?? "", /Next automatic check: none/);
	assert.match(h.render(), /backoff/i);
});

test("very long waits segment local repaint without overflow, HTTP or early eligibility", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: START });
	const h = await harness(t);
	h.handler = () => new Response("", {
		status: 503,
		headers: { "Retry-After": "999999999999999999999999999999999999" },
	});
	await h.refresh();
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, 8.64e15);
	const count = h.requests.length;
	const before = h.publications;
	t.mock.timers.tick(2_147_483_646);
	assert.equal(h.publications, before);
	t.mock.timers.tick(1);
	assert.equal(h.publications, before + 1);
	await h.refresh(true);
	assert.equal(h.requests.length, count);
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, 8.64e15);
});

test("actual mixed Management failures count once; skipped provider errors never add local streak", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	let calls = 0;
	h.handler = (input, init) => {
		if (String(input).endsWith("/api-call") && ++calls === 1) {
			return new Response("", { status: 503 });
		}
		return h.reply(input, init);
	};
	await h.refresh();
	assert.equal(h.snapshot().eligibility?.backoffUntil, START + 300_000);
	await h.refresh(true);
	assert.equal(h.snapshot().eligibility?.backoffUntil, undefined, "actual clean source round resets source local policy");
	// DeepSeek discovery receives a Management wait after ordinary discovery;
	// Codex's unstarted account queries inherit the block but were never sent.
	const ordinary = (input: unknown, init?: RequestInit) => String(input).endsWith("/openai-compatibility")
		? new Response("", { status: 429, headers: { "Retry-After": "600" } })
		: h.reply(input, init);
	// Enqueue both providers through the existing coalescing queue while a read is blocked.
	let release!: (value: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<Response>((resolve) => {
		release = resolve;
	});
	let first = true;
	h.handler = (input, init) => {
		if (first) {
			first = false;
			entered();
			return blocked;
		}
		return ordinary(input, init);
	};
	const running = h.refresh(true);
	await started;
	const pendingCodex = h.refresh(true);
	const deepseekContext = {
		...h.ctx,
		model: { provider: "cliproxyapi", id: "deepseek-v4" },
	} as ExtensionCommandContext;
	const pendingDeepseek = h.controller.refreshCurrent(deepseekContext, { force: true, loaded: h.loaded() });
	release(Response.json({ files: [] }));
	await Promise.all([running, pendingCodex, pendingDeepseek]);
	assert.equal(h.snapshot().eligibility?.managementServerUntil, START + 600_000);
	const snapshot = h.snapshot();
	assert.equal(snapshot.accounts.every((account) => !account.queried), true);
	// The first genuine provider temporary failure must start at one interval,
	// not double because of the inherited/skipped Management error above.
	t.mock.timers.setTime(START + 600_000);
	h.phase = "provider-local";
	h.handler = h.reply;
	await h.refresh();
	assert.equal(h.snapshot().eligibility?.backoffUntil, START + 900_000);
});

test("cancelled old-source response cannot install a cooldown in the replacement source", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	let release!: (value: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<Response>((resolve) => {
		release = resolve;
	});
	h.handler = () => {
		entered();
		return blocked;
	};
	const old = h.refresh();
	await started;
	h.settings.managementUrl = "https://replacement.example.invalid";
	await h.save();
	h.controller.resetSettings(h.settings, h.ctx);
	h.handler = h.reply;
	await h.refresh();
	await old;
	release(new Response("", { status: 429, headers: { "Retry-After": "3600" } }));
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(h.snapshot().state, "ready");
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, undefined);
	assert.equal(h.snapshot().eligibility?.automaticAllowedAt, undefined);
});

test("a new model context owns the periodic callback and reset clears both source waits and stale contexts", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: START });
	const h = await harness(t);
	let expired = false;
	const oldContext = new Proxy(h.ctx, {
		get(target, key, receiver) {
			if (expired) {
				throw new Error("expired periodic context accessed");
			}
			return Reflect.get(target, key, receiver);
		},
	});
	h.phase = "management-wait";
	h.controller.start(oldContext, h.loaded());
	await h.controller.refreshCurrent(oldContext, { loaded: h.loaded() });
	h.controller.modelSelected(h.ctx, "codex");
	await h.idle();
	expired = true;
	const count = h.requests.length;
	t.mock.timers.tick(300_000);
	await h.idle();
	assert.equal(h.requests.length, count);
	h.controller.resetSettings(h.settings, h.ctx);
	h.phase = "valid";
	await h.refresh();
	assert.equal(h.snapshot().eligibility?.manualAllowedAt, undefined);
	h.controller.shutdown(h.ctx);
	const publications = h.publications;
	t.mock.timers.tick(3_600_000);
	assert.equal(h.publications, publications);
});

test("skipped discovery keeps cached provider discovery and attempt facts unchanged", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	const deepseekContext = {
		...h.ctx,
		model: { provider: "cliproxyapi", id: "deepseek-v4" },
	} as ExtensionCommandContext;
	h.handler = (input) => String(input).endsWith("/openai-compatibility")
		? Response.json({
			"openai-compatibility": [{
				"base-url": "https://api.deepseek.com",
				"auth-index": "deepseek-d",
			}],
		})
		: Response.json({
			status_code: 200,
			body: {
				is_available: true,
				balance_infos: [{ currency: "CNY", total_balance: "5" }],
			},
		});
	await h.controller.refreshCurrent(deepseekContext, { loaded: h.loaded() });
	const before = h.controller.getSnapshot(deepseekContext);
	assert.equal(before.state, "ready");
	t.mock.timers.setTime(START + 60_000);
	let release!: (response: Response) => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<Response>((resolve) => {
		release = resolve;
	});
	let first = true;
	h.handler = () => {
		if (first) {
			first = false;
			entered();
			return blocked;
		}
		return new Response("", { status: 429 });
	};
	const running = h.refresh();
	await started;
	const codex = h.refresh();
	const deepseek = h.controller.refreshCurrent(deepseekContext, { loaded: h.loaded() });
	release(Response.json({ files: [] }));
	await Promise.all([running, codex, deepseek]);
	const after = h.controller.getSnapshot(deepseekContext);
	assert.equal(h.requests.length, 4, "only seeded DeepSeek, held ordinary discovery and actual 429; no skipped request");
	assert.equal(after.state, "ready");
	assert.deepEqual(after.accounts, before.accounts);
	assert.equal(after.lastAttemptAt, before.lastAttemptAt);
	assert.equal(after.lastCompleteSuccessAt, before.lastCompleteSuccessAt);
	assert.equal(after.error, undefined);
	assert.equal(after.eligibility?.automaticAllowedAt, START + 360_000);
	assert.equal(after.eligibility?.manualAllowedAt, undefined);
});

test("notifications do not bypass Management rejection; explicit force can revalidate it", async (t) => {
	t.mock.timers.enable({ apis: ["Date"], now: START });
	const h = await harness(t);
	h.phase = "auth";
	await h.refresh();
	const count = h.requests.length;
	assert.equal(h.snapshot().state, "setup-required");
	h.phase = "valid";
	await h.controller.refreshCurrent(h.ctx, { notify: true, loaded: h.loaded() });
	assert.equal(h.requests.length, count);
	await h.controller.showStatus(h.ctx);
	assert.match(h.notices.at(-1) ?? "", /Earliest manual request: now.*revalidate/i);
	assert.match(h.notices.at(-1) ?? "", /Earliest automatic request: unavailable/);
	await h.refresh(true);
	assert.equal(h.snapshot().state, "ready");
});
