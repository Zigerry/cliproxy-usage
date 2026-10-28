import assert from "node:assert/strict";
import test from "node:test";
import { normalizedBaseUrl, resolveManagementSource } from "../src/usage.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("Management URLs allow only HTTP(S) without userinfo", async () => {
	for (const value of ["", "not a URL", "ftp://proxy.example/v1", "file:///tmp/auth", "data:text/plain,secret", "ws://proxy.example", "https://user@proxy.example", "https://user:password@proxy.example", "http://:password@proxy.example", "https://%75ser:secret@proxy.example"]) {
		assert.equal(normalizedBaseUrl(value), undefined);
		const source = await resolveManagementSource({ ...DEFAULT_SETTINGS, managementUrl: value || "bad" });
		assert.equal(source.managementUrl, undefined);
		assert.equal(source.error, "invalid managementUrl");
		assert.ok(!JSON.stringify(source).includes("password"));
	}
});

test("Management URL normalization preserves prefixes, IPv6 and existing suffix rules", () => {
	for (const [value, expected] of [
		[" https://proxy.example/ ", "https://proxy.example"],
		["HTTP://proxy.example/v1///?query=1#hash", "http://proxy.example"],
		["https://proxy.example/prefix/v0/management/", "https://proxy.example/prefix"],
		["https://proxy.example/prefix/V1", "https://proxy.example/prefix"],
		["http://[::1]:8317/prefix/v1/", "http://[::1]:8317/prefix"],
		["https://proxy.example/prefix/", "https://proxy.example/prefix"],
	]) assert.equal(normalizedBaseUrl(value), expected);
});
