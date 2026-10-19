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
	configurationStatusText,
	formatAccountSnapshotMetadata,
	formatBalance,
	formatResetTime,
	formatRefreshEligibility,
	remainingColor,
	remainingPercent,
	snapshotStatusText,
	usageBar,
} from "./ui.js";
import type { UsageSnapshot, UsageWindow } from "./types.js";

export type UsageDetailsState = {
	getSnapshot: () => UsageSnapshot;
	onRefresh: () => void;
	onClose: () => void;
	onDispose?: () => void;
};

function windowText(window: Readonly<UsageWindow>, now: number, theme: PiTheme): string {
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
	private disposed = false;
	private readonly clock: ReturnType<typeof setInterval>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: PiTheme,
		private readonly state: UsageDetailsState,
	) {
		// Snapshot ages and reset countdowns advance on a local redraw while
		// the view is open without issuing another network request.
		this.clock = setInterval(() => this.tui.requestRender(), 30_000);
		this.clock.unref?.();
	}

	handleInput(data: string): void {
		if (this.disposed) return;
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
		if (this.disposed) return [];
		const rows = Math.max(0, Math.floor(this.tui.terminal.rows));
		if (rows === 0 || width <= 0) return [];
		const snapshot = this.state.getSnapshot();
		const status = snapshotStatusText(snapshot) || "ready";
		const statusColor = snapshot.state === "error" ? "error" : snapshot.refreshing ? "warning" : "dim";
		const pinned = [this.theme.fg(statusColor, status)];
		const error = snapshot.error ?? snapshot.accounts
			.filter((item) => item.error)
			.map((item) => `${item.label || PROVIDER_LABELS[item.provider]}: ${item.error}`)
			.join(" · ");
		const message = configurationStatusText(snapshot.configuration);
		if (error || message) pinned.push(this.theme.fg("error", [error, message].filter(Boolean).join(" · ")));

		const body: string[] = formatRefreshEligibility(snapshot).map((line) => this.theme.fg("dim", line));
		if (body.length) body.push("");
		for (const item of snapshot.accounts) {
			const provider = this.theme.fg("accent", PROVIDER_LABELS[item.provider]);
			const label = item.label || "remote";
			body.push(`${provider} ${this.theme.fg("dim", "·")} ${this.theme.fg("text", label)}`);
			if (item.result === "unknown") {
				body.push(this.theme.fg("dim", "  unknown"));
			} else if (item.balance) {
				const unavailable = !item.balance.available || item.balance.amounts.every((value) => value.amount <= 0);
				body.push(`  ${this.theme.fg(unavailable ? "error" : "text", formatBalance(item.balance) || "unknown")}`);
			} else if (item.windows.length) {
				for (const window of item.windows) body.push(windowText(window, snapshot.generatedAt, this.theme));
			} else {
				body.push(this.theme.fg("dim", `  ${item.result === "error" ? "error" : "unknown"}`));
			}
			for (const metadata of formatAccountSnapshotMetadata(item, snapshot.generatedAt)) {
				body.push(this.theme.fg(item.error ? "error" : "dim", `  ${metadata}`));
			}
			body.push("");
		}
		while (body.at(-1) === "") body.pop();

		// On tiny terminals keep the state and exit hint, sacrificing frame/body first.
		const framed = rows >= 6 && width >= 4;
		const innerWidth = framed ? width - 2 : width;
		const shortFooter = innerWidth >= visibleWidth("r refresh · Enter/Esc close")
			? "r refresh · Enter/Esc close" : "Esc close";
		if (rows === 1) {
			const close = visibleWidth(`${status} · Esc close`) <= width ? " · Esc close"
				: width >= 6 ? " · Esc" : "";
			return [truncateToWidth(status, width - visibleWidth(close), "", false) + close];
		}
		const visiblePinned = pinned.slice(0, Math.max(1, rows - (framed ? 3 : 1)));
		const available = Math.max(0, rows - (framed ? 3 : 1) - visiblePinned.length);
		const maxOffset = Math.max(0, body.length - available);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + available);
		const footer = `${body.length > available && innerWidth >= visibleWidth(`↑↓ scroll · ${shortFooter}`) ? "↑↓ scroll · " : ""}${shortFooter}`;
		const contents = [...visiblePinned, ...visibleBody, this.theme.fg("dim", footer)];
		if (!framed) return contents.map((line) => truncateToWidth(line, width, "", false));

		const title = truncateToWidth(" CLIProxyAPI Usage ", innerWidth, "", false);
		const border = (text: string) => this.theme.fg("border", text);
		const remaining = Math.max(0, innerWidth - visibleWidth(title));
		const left = Math.floor(remaining / 2);
		const top = border(`╭${"─".repeat(left)}`) + this.theme.fg("accent", title) + border(`${"─".repeat(remaining - left)}╮`);
		const line = (content: string) => border("│") + truncateToWidth(content, innerWidth, "", true) + border("│");
		return [top, ...contents.map(line), border(`╰${"─".repeat(innerWidth)}╯`)];
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		clearInterval(this.clock);
		this.state.onDispose?.();
	}
}
