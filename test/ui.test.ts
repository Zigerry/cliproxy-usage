import assert from "node:assert/strict";
import test from "node:test";
import {
	formatCompact,
	formatDetails,
	renderUsage,
	usageBar,
} from "../src/ui.js";
import type { Theme, UiContext } from "../src/types.js";

test("usageBar clamps usage and supports custom widths", () => {
	assert.equal(usageBar(-10), "░░░░░░░░░░");
	assert.equal(usageBar(0), "░░░░░░░░░░");
	assert.equal(usageBar(25), "███░░░░░░░");
	assert.equal(usageBar(50, 4), "██░░");
	assert.equal(usageBar(100), "██████████");
	assert.equal(usageBar(150), "██████████");
});

test("formatCompact renders full account labels and separates accounts", () => {
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
			"Claude very-long-account-name@example.com  S █████░░░░░ 50%  W ██████████ 100%",
			"Codex work  S ░░░░░░░░░░ 0%",
		].join("\n"),
	);
});

test("renderUsage separates provider, account, and usage", () => {
	let widget: unknown;
	const theme: Theme = { fg: (_color, text) => text };
	const ctx = {
		mode: "interactive",
		ui: {
			theme,
			setStatus() {},
			setWidget: (_id, content) => {
				widget = content;
			},
			notify() {},
			select: async () => undefined,
			input: async () => undefined,
		},
	} satisfies UiContext;

	renderUsage(ctx, [
		{ provider: "claude", label: "user@example.com", session: { used: 50 } },
	]);
	const factory = widget as (
		tui: unknown,
		theme: Theme,
	) => { render(width: number): string[] };
	assert.equal(
		factory(undefined, theme).render(100)[0],
		"● Claude │ user@example.com │ S █████░░░░░ 50%\u001b[0m",
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
