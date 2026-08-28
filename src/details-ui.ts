import type { Theme as PiTheme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { PROVIDER_LABELS } from "./providers.js";
import {
	formatBalance,
	formatResetTime,
	remainingColor,
	remainingPercent,
	usageBar,
} from "./ui.js";
import type { AccountUsage, UsageWindow } from "./types.js";

export type UsageDetailsState = {
	getItems: () => AccountUsage[];
	hasFetched: () => boolean;
	isRefreshing: () => boolean;
	getError: () => string | undefined;
	onRefresh: () => void;
	onClose: () => void;
	onDispose?: () => void;
};

function windowText(window: UsageWindow, now: number, theme: PiTheme): string {
	const remaining = remainingPercent(window);
	const bar = usageBar(remaining);
	const filled = bar.match(/^━*/)?.[0] ?? "";
	const empty = bar.slice(filled.length);
	const reset = window.resetsAt
		? ` · ${formatResetTime(window.resetsAt, now)}`
		: "";
	return (
		`  ${theme.fg("muted", window.label)} ` +
		`${theme.fg(remainingColor(remaining), filled)}${theme.fg("dim", empty)} ` +
		`${theme.fg(remainingColor(remaining), `left ${Math.round(remaining)}%`)}` +
		`${theme.fg("dim", reset)}`
	);
}

/** Interactive, cache-backed account usage view shown by /cliproxy-usage. */
export class UsageDetailsComponent implements Component {
	private scrollOffset = 0;
	private readonly clock: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: PiTheme,
		private readonly state: UsageDetailsState,
	) {
		// Reset countdowns are derived from Date.now(), so redraw periodically while
		// the view is open without issuing another network request.
		this.clock = setInterval(() => this.tui.requestRender(), 30_000);
		this.clock.unref?.();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
			this.state.onClose();
			return;
		}
		if (matchesKey(data, "r")) {
			this.scrollOffset = 0;
			this.state.onRefresh();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.scrollOffset++;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(
				0,
				this.scrollOffset - Math.max(1, this.tui.terminal.rows - 5),
			);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollOffset += Math.max(1, this.tui.terminal.rows - 5);
			this.tui.requestRender();
		}
	}

	render(width: number): string[] {
		if (width <= 1) return [truncateToWidth("…", width, "", false)];

		const innerWidth = Math.max(0, width - 2);
		const title = truncateToWidth(" CLIProxyAPI Usage ", innerWidth, "", false);
		const titleWidth = visibleWidth(title);
		const border = (text: string) => this.theme.fg("border", text);
		const topRemaining = Math.max(0, innerWidth - titleWidth);
		const topLeft = Math.floor(topRemaining / 2);
		const topRight = topRemaining - topLeft;
		const top =
			border(`╭${"─".repeat(topLeft)}`) +
			this.theme.fg("accent", title) +
			border(`${"─".repeat(topRight)}╮`);
		const bottom = border(`╰${"─".repeat(innerWidth)}╯`);
		const line = (content: string): string =>
			border("│") +
			truncateToWidth(content, innerWidth, "", true) +
			border("│");

		const now = Date.now();
		const body: string[] = [];
		const items = this.state.getItems();
		for (const item of items) {
			const provider = this.theme.fg(
				"accent",
				PROVIDER_LABELS[item.provider],
			);
			const label = item.label || "remote";
			body.push(`${provider} ${this.theme.fg("dim", "·")} ${this.theme.fg("text", label)}`);
			if (item.error) {
				body.push(this.theme.fg("error", `  ! ${item.error}`));
			} else if (item.balance) {
				const unavailable =
					!item.balance.available ||
					item.balance.amounts.every((value) => value.amount <= 0);
				body.push(
					`  ${this.theme.fg(
						unavailable ? "error" : "text",
						formatBalance(item.balance) || "No balance",
					)}`,
				);
			} else if (item.windows.length) {
				for (const window of item.windows) {
					body.push(windowText(window, now, this.theme));
				}
			} else {
				body.push(this.theme.fg("dim", "  No usage window"));
			}
			body.push("");
		}

		if (!items.length) {
			body.push(
				this.theme.fg(
					"dim",
					this.state.hasFetched()
						? "No enabled CLIProxyAPI accounts found."
						: "No cached usage yet.",
				),
			);
		}

		const error = this.state.getError();
		const status = this.state.isRefreshing()
			? this.theme.fg("warning", "Refreshing…")
			: error
				? this.theme.fg(
						"error",
						`Refresh failed: ${error}${this.state.hasFetched() ? " · showing cached data" : ""}`,
					)
				: undefined;
		if (status) body.unshift(status, "");

		while (body.at(-1) === "") body.pop();
		const footerText = [
			...(this.hasOverflow(body, this.bodyHeight()) ? ["↑↓ scroll"] : []),
			"r refresh",
			"Enter/Esc close",
		].join(" · ");
		const available = this.bodyHeight();
		const maxOffset = Math.max(0, body.length - available);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + available);

		return [
			top,
			...visibleBody.map(line),
			line(this.theme.fg("dim", footerText)),
			bottom,
		];
	}

	invalidate(): void {}

	dispose(): void {
		clearInterval(this.clock);
		this.state.onDispose?.();
	}

	private bodyHeight(): number {
		return Math.max(1, this.tui.terminal.rows - 3);
	}

	private hasOverflow(body: string[], available: number): boolean {
		return body.length > available;
	}
}
