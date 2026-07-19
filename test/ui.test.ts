import assert from "node:assert/strict";
import test from "node:test";
import { formatCompact, formatDetails, usageBar } from "../src/ui.js";

test("usageBar clamps usage and supports custom widths", () => {
	assert.equal(usageBar(-10), "░░░░░░░░░░");
	assert.equal(usageBar(0), "░░░░░░░░░░");
	assert.equal(usageBar(25), "███░░░░░░░");
	assert.equal(usageBar(50, 4), "██░░");
	assert.equal(usageBar(100), "██████████");
	assert.equal(usageBar(150), "██████████");
});

test("formatCompact renders provider labels, truncates email, and separates accounts", () => {
	assert.equal(
		formatCompact([
			{
				provider: "claude",
				label: "very-long-account-name@example.com",
				session: { used: 49.6 },
				weekly: { used: 100 },
			},
			{ provider: "codex", label: "work", session: { used: 0 } },
		]),
		[
			"Claude very-long-account-  S █████░░░░░ 50%  W ██████████ 100%",
			"Codex work  S ░░░░░░░░░░ 0%",
		].join("\n"),
	);
});

test("formatCompact handles errors and missing windows", () => {
	assert.equal(
		formatCompact([
			{ provider: "grok", label: "x", error: "HTTP 401" },
			{ provider: "codex", label: "empty" },
		]),
		"Grok x: ! HTTP 401\nCodex empty  –",
	);
});

test("formatDetails handles empty, success, errors, and missing data", () => {
	assert.equal(formatDetails([]), "No enabled CLIProxyAPI accounts found.");
	assert.equal(
		formatDetails([
			{
				provider: "claude",
				label: "me",
				session: { used: 12.6 },
				weekly: { used: 44.4 },
			},
			{ provider: "grok", label: "bad", error: "HTTP 403" },
			{ provider: "codex", label: "empty" },
		]),
		[
			"claude/me: Session 13% used · Weekly 44% used",
			"grok/bad: HTTP 403",
			"codex/empty: No usage window",
		].join("\n"),
	);
});
