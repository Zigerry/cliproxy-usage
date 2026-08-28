import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { UsageController } from "./src/controller.js";
import { PROVIDERS, PROVIDER_LABELS } from "./src/providers.js";
import { loadSettings, saveSettings } from "./src/settings.js";
import { promptManagementKey, showSettings } from "./src/settings-ui.js";
import {
	managementErrorMessage,
	providerForModel,
	resolveManagementSource,
	validateManagementAccess,
} from "./src/usage.js";

const commandItems = [
	{ value: "setup", description: "Configure Management API access" },
	{ value: "login", description: "Alias for setup" },
	{ value: "logout", description: "Clear the Management API password" },
	{ value: "settings", description: "Open usage settings" },
	{ value: "status", description: "Show effective configuration and refresh state" },
] as const;
const SETTINGS_PATH = join(getAgentDir(), "pi-cliproxy-usage.json");
const PROVIDER_CONFIG_PATH = join(getAgentDir(), "cliproxyapi.json");
const LEGACY_SETTINGS_PATH = join(
	getAgentDir(),
	"extensions",
	"pi-cliproxy-usage",
	"config.json",
);

export default function (pi: ExtensionAPI) {
	const usage = new UsageController({
		settingsPath: SETTINGS_PATH,
		legacySettingsPath: LEGACY_SETTINGS_PATH,
		providerConfigPath: PROVIDER_CONFIG_PATH,
	});

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
		ctx.ui.setStatus(
			"cliproxy-usage",
			ctx.ui.theme.fg("dim", "validating management access…"),
		);
		try {
			await validateManagementAccess(
				loaded.settings,
				PROVIDER_CONFIG_PATH,
				key,
			);
		} catch (error) {
			ctx.ui.notify(managementErrorMessage(error, "setup"), "error");
			return;
		} finally {
			ctx.ui.setStatus("cliproxy-usage", undefined);
		}
		loaded.settings.managementKey = key;
		await saveSettings(loaded.settings, loaded.raw, SETTINGS_PATH);
		usage.resetSettings(loaded.settings);
		ctx.ui.notify(
			`CLIProxyAPI management access configured for ${source.managementUrl}.`,
			"info",
		);
		await usage.refreshCurrent(ctx, { notify: true, force: true });
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
		usage.resetSettings(loaded.settings);
		usage.renderCurrentModel(ctx);
		ctx.ui.notify("CLIProxyAPI management password cleared.", "info");
	};

	const showStatus = async (ctx: ExtensionCommandContext) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		usage.syncSettings(loaded.settings);
		const providers = PROVIDERS.filter(
			(provider) => loaded.settings.providers[provider],
		)
			.map((provider) => PROVIDER_LABELS[provider])
			.join(", ");
		const source = await resolveManagementSource(
			loaded.settings,
			PROVIDER_CONFIG_PATH,
		);
		const currentProvider = ctx.model
			? providerForModel(ctx.model.provider, ctx.model.id)
			: undefined;
		const refreshedAt = usage.lastRefresh(currentProvider)?.toISOString();
		ctx.ui.notify(
			[
				`Settings: ${loaded.path}`,
				`Provider config: ${PROVIDER_CONFIG_PATH}`,
				`Provider base URL: ${source.providerBaseUrl || "not found"}`,
				`Management URL: ${source.managementUrl || source.error || "not found"}`,
				`Management key: ${source.managementKeyConfigured ? "configured" : "missing"}`,
				`Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected"}`,
				`Current usage provider: ${currentProvider ? PROVIDER_LABELS[currentProvider] : "unsupported"}`,
				`Last refresh: ${refreshedAt || "not yet"}`,
				`Refresh: ${loaded.settings.refreshMinutes} min`,
				`Visible accounts: ${loaded.settings.maxVisibleAccounts}`,
				`Providers: ${providers || "none"}`,
				`Settings source: ${Object.keys(loaded.raw).length ? "settings file" : "defaults"}`,
				...(loaded.warnings.length
					? [`Warnings: ${loaded.warnings.join("; ")}`]
					: []),
			].join("\n"),
			loaded.warnings.length || source.error ? "warning" : "info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
		usage.start(ctx, loaded);
	});

	pi.on("model_select", (event, ctx) => {
		usage.modelSelected(
			ctx,
			providerForModel(event.model.provider, event.model.id),
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		usage.shutdown(ctx);
	});

	pi.registerCommand("cliproxy-usage", {
		description: "Refresh, inspect, or configure current-model quota",
		getArgumentCompletions: (prefix) => {
			const value = prefix.trim().toLowerCase();
			const matches = commandItems
				.filter((command) => command.value.startsWith(value))
				.map((command) => ({
					value: command.value,
					label: command.value,
					description: command.description,
				}));
			return matches.length ? matches : null;
		},
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (!action) return usage.showDetails(ctx);
			if (action === "setup" || action === "login") {
				return setupManagement(ctx);
			}
			if (action === "logout") return clearManagement(ctx);
			if (action === "settings") {
				return showSettings(
					ctx,
					SETTINGS_PATH,
					LEGACY_SETTINGS_PATH,
					(settings, changedId) =>
						usage.applySettings(ctx, settings, changedId),
				);
			}
			if (action === "status") return showStatus(ctx);
			ctx.ui.notify(
				`Usage: /cliproxy-usage [${commandItems.map((command) => command.value).join("|")}]`,
				"warning",
			);
		},
	});
}
