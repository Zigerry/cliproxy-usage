import assert from "node:assert/strict";
import test from "node:test";
import { settingsSummary } from "../src/settings-ui.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";

test("settings summary reflects live management URL, key and widget visibility changes", () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	assert.equal(
		settingsSummary(settings, "/tmp/settings.json"),
		"Management URL: automatic\nManagement key: run /cliproxy-usage setup\nWidget visibility: enabled\n/tmp/settings.json",
	);
	settings.managementUrl = "https://proxy.example.com";
	settings.managementKey = "secret";
	settings.showWidget = false;
	assert.equal(
		settingsSummary(settings, "/tmp/settings.json"),
		"Management URL: https://proxy.example.com\nManagement key: configured\nWidget visibility: disabled\n/tmp/settings.json",
	);
});
