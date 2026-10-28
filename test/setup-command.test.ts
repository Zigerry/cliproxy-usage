import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

test("isolated setup/login commands", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "cliproxy-setup-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	// Set before importing index OR any runtime SDK module: never inspect the real agent directory.
	process.env.PI_CODING_AGENT_DIR = dir;
	globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
	try {
		const { default: extension } = await import("../index.js");
		const settingsPath = join(dir, "pi-cliproxy-usage.json");
		const providerPath = join(dir, "cliproxyapi.json");
		const write = (path: string, value: unknown) => writeFile(path, JSON.stringify(value));
		const read = async () => JSON.parse(await readFile(settingsPath, "utf8"));
		const absent = async () => assert.rejects(readFile(settingsPath), { code: "ENOENT" });
		async function harness(options: {
			action?: string; urls?: (string | undefined)[]; key?: string; mode?: string;
			hasUI?: boolean; beforePassword?: () => Promise<void>;
			request?: () => Promise<Response>;
		} = {}) {
			let handler!: (args: string, ctx: ExtensionCommandContext) => Promise<unknown>;
			extension({ on() {}, registerCommand(_name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) { handler = command.handler; } } as unknown as ExtensionAPI);
			const notices: string[] = [], screens: string[] = [], requests: string[] = [];
			let inputs = 0, passwords = 0;
			const urls = [...(options.urls ?? [])];
			const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
			const ctx = {
				mode: options.mode ?? "tui", hasUI: options.hasUI ?? true,
				ui: {
					theme, setStatus() {}, setWidget() {}, confirm: async () => true,
					notify: (message: string) => notices.push(message),
					input: async () => { inputs++; assert.ok(inputs < 10); return urls.shift(); },
					custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
						passwords++;
						await options.beforePassword?.();
						return new Promise((resolve) => {
							const component = factory({ requestRender() {} } as never, theme as never, {} as never, resolve);
							assert.ok(!(component instanceof Promise));
							if (component instanceof Promise) throw new Error("Unexpected async component");
							screens.push(component.render(120).join("\n"));
							if (options.key !== undefined) {
								component.handleInput?.(options.key);
								assert.ok(!component.render(120).join("\n").includes(options.key));
								component.handleInput?.("\r");
							} else component.handleInput?.("\x1b");
						});
					},
				},
			} as unknown as ExtensionCommandContext;
			globalThis.fetch = async (url, init) => {
				requests.push(String(url));
				assert.equal(new Headers(init?.headers).get("Authorization"), `Bearer ${options.key}`);
				return options.request ? options.request() : new Response(JSON.stringify({ files: [] }));
			};
			await handler(options.action ?? "setup", ctx);
			assert.ok(!notices.join("\n").includes(options.key ?? "never-disclose-this-secret"));
			return { notices, screens, requests, inputs, passwords, handler, ctx };
		}
		const reset = async () => {
			for (const name of [settingsPath, providerPath]) await rm(name, { recursive: true, force: true });
		};

		for (const action of ["setup", "login"]) await t.test(`${action}: first-run URL then masked password, saved 0600`, async () => {
			await reset();
			const result = await harness({ action, urls: ["https://proxy.example/prefix/v1/"], key: "fresh-password" });
			assert.equal(result.inputs, 1); assert.equal(result.passwords, 1);
			assert.match(result.screens[0], /Endpoint:.*https:\/\/proxy.example\/prefix/);
			assert.deepEqual(result.requests, ["https://proxy.example/prefix/v0/management/auth-files"]);
			assert.equal((await read()).managementUrl, "https://proxy.example/prefix");
			assert.equal((await read()).managementKey, "fresh-password");
			assert.equal((await stat(settingsPath)).mode & 0o777, 0o600);
		});

		for (const override of [false, true]) await t.test(`valid ${override ? "override" : "inferred"} URL needs no URL prompt`, async () => {
			await reset();
			await write(providerPath, { baseUrl: "http://[::1]:8317/prefix/v1/" });
			if (override) await write(settingsPath, { managementUrl: "https://override.example/v0/management/", extra: 42 });
			const result = await harness({ key: "existing-source-password" });
			assert.equal(result.inputs, 0);
			assert.deepEqual(result.requests, [override ? "https://override.example/v0/management/auth-files" : "http://[::1]:8317/prefix/v0/management/auth-files"]);
			assert.equal((await read()).managementUrl, override ? "https://override.example/v0/management/" : "");
			if (override) assert.equal((await read()).extra, 42);
		});

		await t.test("invalid URLs can be corrected without displaying embedded credentials", async () => {
			await reset();
			await write(settingsPath, { managementUrl: "https://private-user:private-pass@proxy.example", managementKey: "old-password" });
			const result = await harness({ urls: ["ftp://proxy.example", "file:///tmp/secret", "https://private-user:private-pass@proxy.example", "https://fixed.example/v1"], key: "replacement-password" });
			assert.equal(result.inputs, 4);
			assert.deepEqual(result.requests, ["https://fixed.example/v0/management/auth-files"]);
			assert.ok(![...result.notices, ...result.screens].join("\n").includes("private-"));
			assert.equal((await read()).managementUrl, "https://fixed.example");
		});

		for (const urls of [[undefined], ["", "bad-url", undefined], ["https://proxy.example"]]) await t.test(`cancel URL/password: ${JSON.stringify(urls)}`, async () => {
			await reset();
			const result = await harness({ urls });
			assert.equal(result.requests.length, 0);
			assert.equal(result.passwords, urls[0] === "https://proxy.example" ? 1 : 0);
			await absent();
		});

		await t.test("password cancellation preserves existing invalid URL and password byte-for-byte", async () => {
			await reset();
			await write(settingsPath, { managementUrl: "file:///private", managementKey: "old-password" });
			const before = await readFile(settingsPath, "utf8");
			const result = await harness({ urls: ["https://corrected.example"] });
			assert.equal(result.passwords, 1);
			assert.equal(result.requests.length, 0);
			assert.equal(await readFile(settingsPath, "utf8"), before);
		});

		await t.test("first-run rejected password creates no settings file", async () => {
			await reset();
			await harness({ urls: ["https://proxy.example"], key: "rejected-password", request: async () => new Response("", { status: 401 }) });
			await absent();
		});

		for (const failure of ["401", "network"]) await t.test(`${failure}: no new URL or password saved`, async () => {
			await reset();
			await write(settingsPath, { managementUrl: "invalid", managementKey: "old-password", extra: 42 });
			const before = await readFile(settingsPath, "utf8");
			const result = await harness({ urls: ["https://proxy.example"], key: "rejected-password", request: async () => {
				if (failure === "network") throw new Error("rejected-password https://user:pass@private.example");
				return new Response("", { status: 401 });
			} });
			assert.equal(result.requests.length, 1);
			assert.equal(await readFile(settingsPath, "utf8"), before);
			assert.match(result.notices.join("\n"), failure === "401" ? /password rejected/ : /request failed/);
		});

		for (const mode of ["rpc", "json", "print"]) await t.test(`${mode}: no dialogs, request or settings write`, async () => {
			await reset();
			const result = await harness({ mode, hasUI: mode === "rpc", key: "unused-password" });
			assert.equal(result.inputs + result.passwords + result.requests.length, 0);
			if (mode !== "rpc") assert.deepEqual(result.notices, []);
			await absent();
		});

		await t.test("provider change during password entry cannot redirect validation or freeze stale inference", async () => {
			await reset();
			await write(providerPath, { baseUrl: "https://shown.example/v1" });
			const result = await harness({ key: "pinned-password", beforePassword: () => write(providerPath, { baseUrl: "https://changed.example/v1" }) });
			assert.match(result.screens[0], /https:\/\/shown.example/);
			assert.deepEqual(result.requests, ["https://shown.example/v0/management/auth-files"]);
			assert.match(result.notices.join("\n"), /Configuration changed/);
			await absent();
		});

		await t.test("new settings during validation are not overwritten", async () => {
			await reset();
			const newer = { managementUrl: "https://new.example", managementKey: "newer-key", showWidget: false };
			const result = await harness({ urls: ["https://shown.example"], key: "stale-password", request: async () => {
				await write(settingsPath, newer);
				return new Response(JSON.stringify({ files: [] }));
			} });
			assert.deepEqual(await read(), newer);
			assert.match(result.notices.join("\n"), /Configuration changed/);
		});

		await t.test("logout during validation does not resurrect credentials", async () => {
			await reset();
			await write(settingsPath, { managementUrl: "https://shown.example", managementKey: "old-password" });
			let logout!: () => Promise<unknown>;
			extension({ on() {}, registerCommand(_name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) {
				logout = () => command.handler("logout", { ui: { confirm: async () => true, notify() {}, setStatus() {}, setWidget() {} } } as unknown as ExtensionCommandContext);
			} } as unknown as ExtensionAPI);
			const result = await harness({ key: "stale-password", request: async () => {
				await logout();
				return new Response(JSON.stringify({ files: [] }));
			} });
			assert.equal((await read()).managementKey, "");
			assert.match(result.notices.join("\n"), /Configuration changed/);
		});

		await t.test("save failure is friendly and does not expose secret or write settings", async () => {
			await reset();
			const originalNow = Date.now;
			Date.now = () => 123;
			const temp = `${settingsPath}.${process.pid}.123.tmp`;
			try {
				await mkdir(temp);
				const result = await harness({ urls: ["https://shown.example"], key: "unsaved-password" });
				assert.match(result.notices.join("\n"), /Unable to complete Management setup/);
				await absent();
			} finally { Date.now = originalNow; await rm(temp, { recursive: true, force: true }); }
		});
	} finally {
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		await rm(dir, { recursive: true, force: true });
	}
});
