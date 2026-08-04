import type {
	AccountUsage,
	ProviderName,
	Theme,
	UiContext,
	UsageWindow,
} from "./types.js";

const PROVIDER_LABELS: Record<ProviderName, string> = {
	claude: "Claude",
	codex: "Codex",
	grok: "Grok",
	kimi: "Kimi",
};
const CLAUDE_ORANGE = "\u001b[38;5;208m";

function accountLabel(label: string): string {
	return label;
}

/** Remaining quota in percent, clamped to 0-100. */
export function remainingPercent(window: UsageWindow): number {
	return Math.max(0, Math.min(100, 100 - window.used));
}

/** Color by remaining quota: green normally, yellow below 30%, red below 10%. */
export function remainingColor(remaining: number): string {
	if (remaining < 10) return "error";
	if (remaining < 30) return "warning";
	return "success";
}

export function usageBar(percent: number, width = 8): string {
	const value = Math.max(0, Math.min(100, percent));
	const filled = Math.round((value / 100) * width);
	return "━".repeat(filled) + "─".repeat(width - filled);
}

function formatWindow(window: UsageWindow): string {
	const remaining = remainingPercent(window);
	return `${window.label} ${usageBar(remaining)} left ${Math.round(remaining)}%`;
}

function maxUsed(item: AccountUsage): number {
	return Math.max(-1, ...item.windows.map((window) => window.used));
}

export function formatCompact(items: AccountUsage[]): string {
	return items
		.map((item) => {
			if (item.error) {
				return `${PROVIDER_LABELS[item.provider]} ${accountLabel(item.label)}: ! ${item.error}`;
			}
			const windows = item.windows.map(formatWindow);
			return `${PROVIDER_LABELS[item.provider]} ${accountLabel(item.label)}  ${windows.join("  ") || "–"}`;
		})
		.join("\n");
}

export function formatDetails(items: AccountUsage[]): string {
	if (!items.length) return "No enabled CLIProxyAPI accounts found.";
	return items
		.map((item) => {
			if (item.error) return `${item.provider}/${item.label}: ${item.error}`;
			const windows = item.windows.map(formatWindow);
			return `${item.provider}/${item.label}: ${windows.join(" · ") || "No usage window"}`;
		})
		.join("\n");
}

function truncateAnsi(text: string, width: number): string {
	let visible = 0;
	let result = "";
	for (let index = 0; index < text.length && visible < width; ) {
		if (text[index] === "\u001b") {
			const match = text.slice(index).match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
			if (match) {
				result += match[0];
				index += match[0].length;
				continue;
			}
		}
		const point = text.codePointAt(index);
		if (point === undefined) break;
		result += String.fromCodePoint(point);
		index += point > 0xffff ? 2 : 1;
		visible++;
	}
	return `${result}\u001b[0m`;
}

function ansiWidth(text: string): number {
	return Array.from(
		text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ""),
	).length;
}

function padAnsi(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - ansiWidth(text)));
}

function fitPlain(text: string, width: number): string {
	const points = Array.from(text);
	if (points.length <= width) return text.padEnd(width);
	if (width <= 1) return "…".slice(0, width);
	return `${points.slice(0, width - 1).join("")}…`;
}

export function clearUsage(ctx: UiContext): void {
	ctx.ui.setStatus("cliproxy-usage", undefined);
	ctx.ui.setWidget("cliproxy-usage", undefined);
}

export function renderUsage(
	ctx: UiContext,
	items: AccountUsage[],
	maxVisibleAccounts: number,
): void {
	ctx.ui.setStatus("cliproxy-usage", undefined);
	if (!items.length) {
		ctx.ui.setWidget("cliproxy-usage", undefined);
		return;
	}
	const visibleItems = items
		.map((item, index) => ({
			item,
			index,
			priority: item.error ? Number.POSITIVE_INFINITY : maxUsed(item),
		}))
		.sort(
			(left, right) =>
				right.priority - left.priority || left.index - right.index,
		)
		.slice(0, maxVisibleAccounts)
		.map(({ item }) => item);
	const hiddenCount = items.length - visibleItems.length;
	ctx.ui.setWidget(
		"cliproxy-usage",
		(_tui: unknown, theme: Theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const columns = Math.min(
					visibleItems.length,
					width >= 165 ? 3 : width >= 104 ? 2 : 1,
				);
				const gap = 2;
				const cellWidth = Math.max(
					1,
					Math.floor((width - gap * (columns - 1)) / columns),
				);
				const barWidth = columns === 3 ? 4 : columns === 2 ? 6 : 8;
				const providers = new Set(visibleItems.map((item) => item.provider));
				const groupedProvider =
					providers.size === 1 && visibleItems.length > 1
						? visibleItems[0]?.provider
						: undefined;
				const providerWidth = groupedProvider
					? 0
					: Math.max(
							...visibleItems.map(
								(item) => PROVIDER_LABELS[item.provider].length,
							),
						);
				const styledProvider = (provider: ProviderName, text: string) =>
					provider === "claude"
						? `${CLAUDE_ORANGE}${text}\u001b[0m`
						: theme.fg("text", text);
				const meter = (window: UsageWindow) => {
					const remaining = remainingPercent(window);
					const color = remainingColor(remaining);
					const bar = usageBar(remaining, barWidth);
					const filled = bar.match(/^━*/)?.[0] ?? "";
					const empty = bar.slice(filled.length);
					return [
						theme.fg("muted", window.label),
						`${theme.fg(color, filled)}${theme.fg("dim", empty)}`,
						theme.fg(color, `left ${Math.round(remaining)}%`),
					].join(" ");
				};
				const contents = visibleItems.map((item) => {
					if (item.error) return theme.fg("error", `! ${item.error}`);
					const meters = item.windows.map(meter);
					return meters.length
						? meters.join(theme.fg("dim", " │ "))
						: theme.fg("dim", "–");
				});
				const maxContentWidth = Math.max(
					...contents.map((content) =>
						Math.max(1, Math.min(ansiWidth(content), cellWidth - 8)),
					),
				);
				const prefixWidth = groupedProvider ? 3 : providerWidth + 6;
				const accountBudget = Math.max(
					6,
					Math.min(
						24,
						cellWidth - prefixWidth - Math.max(1, maxContentWidth),
					),
				);
				const accountWidth = Math.max(
					1,
					Math.min(
						accountBudget,
						Math.max(
							...visibleItems.map(
								(item) => Array.from(accountLabel(item.label)).length,
							),
						),
					),
				);
				const cards = visibleItems.map((item, index) => {
					const separator = theme.fg("dim", " │ ");
					const account = theme.fg(
						"muted",
						fitPlain(accountLabel(item.label), accountWidth),
					);
					const prefix = groupedProvider
						? account + separator
						: styledProvider(
								item.provider,
								PROVIDER_LABELS[item.provider].padEnd(providerWidth),
							) +
							separator +
							account +
							separator;
					return truncateAnsi(`${prefix}${contents[index]}`, cellWidth);
				});
				const lines: string[] = [];
				if (groupedProvider) {
					const count = items.length;
					lines.push(
						truncateAnsi(
							`${styledProvider(groupedProvider, PROVIDER_LABELS[groupedProvider])} ${theme.fg(
								"dim",
								`quota · ${count} account${count === 1 ? "" : "s"}`,
							)}`,
							width,
						),
					);
				}
				for (let index = 0; index < cards.length; index += columns) {
					const row = cards.slice(index, index + columns);
					lines.push(
						row
							.map((card, cellIndex) =>
								cellIndex < row.length - 1
									? padAnsi(card, cellWidth)
									: card,
							)
							.join(" ".repeat(gap)),
					);
				}
				if (hiddenCount) {
					lines.push(
						truncateAnsi(
							theme.fg(
								"dim",
								`… ${hiddenCount} more account${hiddenCount === 1 ? "" : "s"} · /cliproxy-usage for details`,
							),
							width,
						),
					);
				}
				return lines;
			},
		}),
		{ placement: "belowEditor" },
	);
}
