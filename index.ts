import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadSettings } from "./src/settings.js";
import { showSettings } from "./src/settings-ui.js";
import { accountsForModel, readAccounts } from "./src/usage.js";
import { clearUsage, formatDetails, renderUsage } from "./src/ui.js";
import type { AccountUsage, Settings } from "./src/types.js";

const commands = ["settings", "status"];
const SETTINGS_PATH = join(getAgentDir(), "pi-cliproxy-usage.json");
const LEGACY_SETTINGS_PATH = join(
	getAgentDir(),
	"extensions",
	"pi-cliproxy-usage",
	"config.json",
);

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing: Promise<void> | undefined;
	let latestItems: AccountUsage[] = [];
	let maxVisibleAccounts = 4;

	const itemsForCurrentModel = (
		ctx: ExtensionContext,
		items = latestItems,
	): AccountUsage[] => {
		if (!ctx.model) return [];
		return accountsForModel(items, ctx.model.provider, ctx.model.id);
	};

	const renderCurrentModel = (ctx: ExtensionContext) => {
		renderUsage(ctx, itemsForCurrentModel(ctx), maxVisibleAccounts);
	};

	const refresh = (ctx: ExtensionContext, notify = false) =>
		(refreshing ??= (async () => {
			const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
			if (loaded.warnings.length && ctx.hasUI) {
				ctx.ui.notify(loaded.warnings.join("; "), "warning");
			}
			latestItems = await readAccounts(loaded.settings);
			maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
			const items = itemsForCurrentModel(ctx);
			renderUsage(ctx, items, maxVisibleAccounts);
			if (notify) {
				ctx.ui.notify(
					items.length
						? formatDetails(items)
						: "No CLIProxyAPI usage matches the current model.",
					items.some((item) => item.error) ? "warning" : "info",
				);
			}
		})().finally(() => {
			refreshing = undefined;
		}));

	const scheduleRefresh = (ctx: ExtensionContext, minutes: number) => {
		if (timer) clearInterval(timer);
		timer = setInterval(() => void refresh(ctx), minutes * 60_000);
		timer.unref?.();
	};

	const applySettings = async (
		ctx: ExtensionContext,
		settings: Settings,
		changedId: string,
	) => {
		scheduleRefresh(ctx, settings.refreshMinutes);
		// Display-only changes rerender cached data without another provider call.
		if (changedId === "maxVisibleAccounts") {
			maxVisibleAccounts = settings.maxVisibleAccounts;
			renderCurrentModel(ctx);
			return;
		}
		if (changedId === "refreshMinutes") return;
		await refresh(ctx);
	};

	const showStatus = async (ctx: ExtensionCommandContext) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		const providers = Object.entries(loaded.settings.providers)
			.filter(([, enabled]) => enabled)
			.map(([name]) => name)
			.join(", ");
		ctx.ui.notify(
			[
				`Settings: ${loaded.path}`,
				`Accounts: ${loaded.settings.accountsDir}`,
				`Refresh: ${loaded.settings.refreshMinutes} min`,
				`Visible accounts: ${loaded.settings.maxVisibleAccounts}`,
				`Providers: ${providers || "none"}`,
				`Source: ${Object.keys(loaded.raw).length ? "settings file" : "defaults"}`,
			].join("\n"),
			loaded.warnings.length ? "warning" : "info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		if (loaded.warnings.length && ctx.hasUI) {
			ctx.ui.notify(loaded.warnings.join("; "), "warning");
		}
		await refresh(ctx);
		scheduleRefresh(ctx, loaded.settings.refreshMinutes);
	});

	pi.on("model_select", (event, ctx) => {
		renderUsage(
			ctx,
			accountsForModel(latestItems, event.model.provider, event.model.id),
			maxVisibleAccounts,
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		latestItems = [];
		clearUsage(ctx);
	});

	pi.registerCommand("cliproxy-usage", {
		description: "Show current-model quota or manage extension settings",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trim().toLowerCase();
			const matches = commands
				.filter((command) => command.startsWith(value))
				.map((command) => ({ value: command, label: command }));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) return refresh(ctx, true);
			if (action === "settings") {
				return showSettings(
					ctx,
					SETTINGS_PATH,
					LEGACY_SETTINGS_PATH,
					(settings, changedId) => applySettings(ctx, settings, changedId),
				);
			}
			if (action === "status") return showStatus(ctx);
			ctx.ui.notify(
				`Usage: /cliproxy-usage [${commands.join("|")}]`,
				"warning",
			);
		},
	});
}
