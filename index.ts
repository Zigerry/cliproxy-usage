import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadSettings, saveSettings } from "./src/settings.js";
import {
	promptManagementKey,
	showSettings,
} from "./src/settings-ui.js";
import {
	accountsForModel,
	ManagementHttpError,
	readAccounts,
	resolveManagementSource,
	validateManagementAccess,
} from "./src/usage.js";
import { clearUsage, formatDetails, renderUsage } from "./src/ui.js";
import type { AccountUsage, Settings } from "./src/types.js";

const commands = ["setup", "logout", "settings", "status"];
const SETTINGS_PATH = join(getAgentDir(), "pi-cliproxy-usage.json");
const PROVIDER_CONFIG_PATH = join(getAgentDir(), "cliproxyapi.json");
const LEGACY_SETTINGS_PATH = join(
	getAgentDir(),
	"extensions",
	"pi-cliproxy-usage",
	"config.json",
);

function setupErrorMessage(error: unknown): string {
	if (error instanceof ManagementHttpError) {
		if (error.status === 401 || error.status === 403) {
			return `Management password rejected (HTTP ${error.status}).`;
		}
		if (error.status === 404) {
			return "Management API not found (HTTP 404). Check CLIProxyAPI management configuration.";
		}
	}
	return error instanceof Error ? error.message : String(error);
}

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let refreshing: Promise<void> | undefined;
	let latestItems: AccountUsage[] = [];
	let maxVisibleAccounts = 4;
	let rejectedManagementKey: string | undefined;

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

	const refresh = (
		ctx: ExtensionContext,
		notify = false,
		force = false,
	) =>
		(refreshing ??= (async () => {
			const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
			if (loaded.warnings.length && ctx.hasUI) {
				ctx.ui.notify(loaded.warnings.join("; "), "warning");
			}
			maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
			if (
				!force &&
				!notify &&
				loaded.settings.managementKey &&
				rejectedManagementKey === loaded.settings.managementKey
			) {
				renderCurrentModel(ctx);
				return;
			}
			let managementAuthFailed = false;
			latestItems = await readAccounts(loaded.settings, {
				providerConfigPath: PROVIDER_CONFIG_PATH,
				onManagementAuthFailure: () => {
					managementAuthFailed = true;
				},
			});
			rejectedManagementKey = managementAuthFailed
				? loaded.settings.managementKey
				: undefined;
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
		if (changedId === "maxVisibleAccounts") {
			maxVisibleAccounts = settings.maxVisibleAccounts;
			renderCurrentModel(ctx);
			return;
		}
		if (changedId === "refreshMinutes") return;
		rejectedManagementKey = undefined;
		await refresh(ctx, false, true);
	};

	const setupManagement = async (ctx: ExtensionCommandContext) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		if (!loaded.writable) {
			ctx.ui.notify(
				`Cannot update invalid settings: ${loaded.warnings.join(", ")}`,
				"error",
			);
			return;
		}
		const source = await resolveManagementSource(
			loaded.settings,
			PROVIDER_CONFIG_PATH,
		);
		if (source.error || !source.managementUrl) {
			ctx.ui.notify(
				source.error ||
					"CLIProxyAPI base URL not found. Run /login CLIProxyAPI or set managementUrl in settings.",
				"error",
			);
			return;
		}
		const key = await promptManagementKey(ctx, source.managementUrl);
		if (key === undefined) return;
		try {
			await validateManagementAccess(
				loaded.settings,
				PROVIDER_CONFIG_PATH,
				key,
			);
		} catch (error) {
			ctx.ui.notify(setupErrorMessage(error), "error");
			return;
		}
		loaded.settings.managementKey = key;
		await saveSettings(loaded.settings, loaded.raw, SETTINGS_PATH);
		rejectedManagementKey = undefined;
		ctx.ui.notify(
			`CLIProxyAPI management access configured for ${source.managementUrl}.`,
			"info",
		);
		if (refreshing) await refreshing;
		await refresh(ctx, true, true);
	};

	const clearManagement = async (ctx: ExtensionCommandContext) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		if (!loaded.writable) {
			ctx.ui.notify(
				`Cannot update invalid settings: ${loaded.warnings.join(", ")}`,
				"error",
			);
			return;
		}
		if (!loaded.settings.managementKey) {
			ctx.ui.notify("Management password is not configured.", "info");
			return;
		}
		const confirmed = await ctx.ui.confirm(
			"Clear CLIProxyAPI management password?",
			"Quota refresh will stop until /cliproxy-usage setup is run again.",
		);
		if (!confirmed) return;
		loaded.settings.managementKey = "";
		await saveSettings(loaded.settings, loaded.raw, SETTINGS_PATH);
		rejectedManagementKey = undefined;
		if (refreshing) await refreshing;
		await refresh(ctx, false, true);
		ctx.ui.notify("CLIProxyAPI management password cleared.", "info");
	};

	const showStatus = async (ctx: ExtensionCommandContext) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		const providers = Object.entries(loaded.settings.providers)
			.filter(([, enabled]) => enabled)
			.map(([name]) => name)
			.join(", ");
		const source = await resolveManagementSource(
			loaded.settings,
			PROVIDER_CONFIG_PATH,
		);
		ctx.ui.notify(
			[
				`Settings: ${loaded.path}`,
				`Provider config: ${PROVIDER_CONFIG_PATH}`,
				`Provider base URL: ${source.providerBaseUrl || "not found"}`,
				`Management URL: ${source.managementUrl || source.error || "not found"}`,
				`Management key: ${source.managementKeyConfigured ? "configured" : "missing"}`,
				`Refresh: ${loaded.settings.refreshMinutes} min`,
				`Visible accounts: ${loaded.settings.maxVisibleAccounts}`,
				`Providers: ${providers || "none"}`,
				`Settings source: ${Object.keys(loaded.raw).length ? "settings file" : "defaults"}`,
			].join("\n"),
			loaded.warnings.length || source.error ? "warning" : "info",
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
		rejectedManagementKey = undefined;
		clearUsage(ctx);
	});

	pi.registerCommand("cliproxy-usage", {
		description: "Show current-model quota or configure management access",
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
			if (action === "setup") return setupManagement(ctx);
			if (action === "logout") return clearManagement(ctx);
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
