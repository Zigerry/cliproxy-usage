import assert from "node:assert/strict";
import test from "node:test";
import { settingsSummary } from "../src/settings-ui.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("settings summary reflects live management URL and key changes", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	assert.equal(
		settingsSummary(settings, "/tmp/settings.json"),
		"Management URL: automatic\nManagement key: run /cliproxy-usage setup\n/tmp/settings.json",
	);
	settings.managementUrl = "https://proxy.example.com";
	settings.managementKey = "secret";
	assert.equal(
		settingsSummary(settings, "/tmp/settings.json"),
		"Management URL: https://proxy.example.com\nManagement key: configured\n/tmp/settings.json",
	);
});
