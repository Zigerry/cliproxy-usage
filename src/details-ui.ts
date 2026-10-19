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
	formatRefreshEligibility,
	layoutAccountIdentity,
	layoutBalance,
	layoutProse,
	layoutQuotaWindow,
	snapshotStatusText,
} from "./ui.js";
import type { UsageSnapshot } from "./types.js";

export type UsageDetailsState = {
	getSnapshot: () => UsageSnapshot;
	onRefresh: () => void;
	onClose: () => void;
	onDispose?: () => void;
};

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
		// Framing consumes columns before any semantic field is laid out.
		const framed = rows >= 6 && width >= 4;
		const innerWidth = framed ? width - 2 : width;
		const indent = innerWidth >= 4 ? "  " : "";
		const dataWidth = innerWidth - visibleWidth(indent);
		const snapshot = this.state.getSnapshot();
		const status = snapshotStatusText(snapshot) || "ready";
		const statusColor = snapshot.state === "error" ? "error" : snapshot.refreshing ? "warning" : "dim";
		const pinned = layoutProse(this.theme.fg(statusColor, status), innerWidth);
		const error = snapshot.error ?? snapshot.accounts
			.filter((item) => item.error)
			.map((item) => `${item.error} (${item.label || PROVIDER_LABELS[item.provider]})`)
			.join(" · ");
		const message = configurationStatusText(snapshot.configuration);
		if (error || message) pinned.push(truncateToWidth(this.theme.fg("error", [error, message].filter(Boolean).join(" · ")), innerWidth, "…"));

		const body: string[] = formatRefreshEligibility(snapshot).flatMap((line) => layoutProse(this.theme.fg("dim", line), innerWidth));
		if (body.length) body.push("");
		for (const [index, item] of snapshot.accounts.entries()) {
			const provider = this.theme.fg("accent", PROVIDER_LABELS[item.provider]);
			const label = item.label || "remote";
			body.push(layoutAccountIdentity(provider, label, index + 1, innerWidth, this.theme, innerWidth, " · ",
				snapshot.accounts.some((other) => other !== item && (other.label || "remote") === label)));
			let data: string[];
			if (item.result === "unknown") {
				data = [this.theme.fg("dim", dataWidth >= 7 ? "unknown" : "…")];
			} else if (item.balance) {
				data = layoutBalance(item.balance, dataWidth, this.theme);
			} else if (item.windows.length) {
				data = item.windows.flatMap((window) => layoutQuotaWindow(window, dataWidth, this.theme, 8, snapshot.generatedAt));
			} else {
				data = layoutProse(this.theme.fg("dim", item.result === "error" ? "error" : "unknown"), dataWidth);
			}
			body.push(...data.map((line) => indent + line));
			for (const metadata of formatAccountSnapshotMetadata(item, snapshot.generatedAt)) {
				body.push(...layoutProse(this.theme.fg(item.error ? "error" : "dim", metadata), dataWidth).map((line) => indent + line));
			}
			body.push("");
		}
		while (body.at(-1) === "") body.pop();

		// On tiny terminals keep the state and exit hint, sacrificing frame/body first.
		const shortFooter = innerWidth >= visibleWidth("r refresh · Enter/Esc close")
			? "r refresh · Enter/Esc close" : "Esc close";
		if (rows === 1) {
			const compact = snapshot.state === "error" ? `error${snapshot.stale ? " · stale" : ""}` : status;
			const close = visibleWidth(`${compact} · Esc close`) <= width ? " · Esc close"
				: width >= 6 ? " · Esc" : "";
			return [truncateToWidth(compact, width - visibleWidth(close), "…", false) + close];
		}
		const visiblePinned = pinned.slice(0, Math.max(1, rows - (framed ? 3 : 1)));
		const available = Math.max(0, rows - (framed ? 3 : 1) - visiblePinned.length);
		const maxOffset = Math.max(0, body.length - available);
		this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + available);
		const footer = `${body.length > available && innerWidth >= visibleWidth(`↑↓ scroll · ${shortFooter}`) ? "↑↓ scroll · " : ""}${shortFooter}`;
		const contents = [...visiblePinned, ...visibleBody, this.theme.fg("dim", truncateToWidth(footer, innerWidth, "…"))];
		if (!framed) return contents;

		const title = truncateToWidth(" CLIProxyAPI Usage ", innerWidth, "", false);
		const border = (text: string) => this.theme.fg("border", text);
		const remaining = Math.max(0, innerWidth - visibleWidth(title));
		const left = Math.floor(remaining / 2);
		const top = border(`╭${"─".repeat(left)}`) + this.theme.fg("accent", title) + border(`${"─".repeat(remaining - left)}╮`);
		const line = (content: string) => border("│") + content + " ".repeat(Math.max(0, innerWidth - visibleWidth(content))) + border("│");
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
