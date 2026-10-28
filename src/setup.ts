import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isDeepStrictEqual } from "node:util";
import { loadSettings, saveSettings } from "./settings.js";
import { promptManagementKey } from "./settings-ui.js";
import type { Settings } from "./types.js";
import {
	managementErrorMessage,
	normalizedBaseUrl,
	resolveManagementSource,
	validateManagementAccess,
} from "./usage.js";

export async function setupManagement(
	ctx: ExtensionCommandContext,
	paths: { settingsPath: string; legacySettingsPath: string; providerConfigPath: string },
	onSaved: (settings: Settings) => Promise<void>,
): Promise<void> {
	if (ctx.mode !== "tui" || !ctx.hasUI) {
		if (ctx.hasUI) ctx.ui.notify("Management setup requires an interactive TUI session.", "warning");
		return;
	}
	try {
		const loaded = await loadSettings(paths.settingsPath, paths.legacySettingsPath);
		if (!loaded.writable) {
			ctx.ui.notify(`Cannot update invalid settings: ${loaded.warnings.join(", ")}`, "error");
			return;
		}
		const source = await resolveManagementSource(loaded.settings, paths.providerConfigPath);
		let managementUrl = source.managementUrl;
		const needsUrl = !managementUrl;
		while (!managementUrl) {
			const value = await ctx.ui.input("CLIProxyAPI Management URL", "http://localhost:8317");
			if (value === undefined) return;
			managementUrl = normalizedBaseUrl(value);
			if (!managementUrl) ctx.ui.notify("Enter a valid HTTP(S) URL without embedded credentials.", "error");
		}
		const key = await promptManagementKey(ctx, managementUrl);
		if (key === undefined) return;
		ctx.ui.setStatus("cliproxy-usage", ctx.ui.theme.fg("dim", "validating management access…"));
		try {
			// Pin the displayed source: never resolve provider configuration after password entry.
			await validateManagementAccess({ ...loaded.settings, managementUrl }, undefined, key);
		} catch (error) {
			ctx.ui.notify(managementErrorMessage(error, "setup"), "error");
			return;
		} finally {
			ctx.ui.setStatus("cliproxy-usage", undefined);
		}
		// Dialogs/network requests yield: do not overwrite newer settings or undo logout.
		const current = await loadSettings(paths.settingsPath, paths.legacySettingsPath);
		const currentSource = await resolveManagementSource(current.settings, paths.providerConfigPath);
		if (!current.writable || !isDeepStrictEqual(current.raw, loaded.raw) ||
			currentSource.managementUrl !== source.managementUrl) {
			ctx.ui.notify("Configuration changed during setup; run /cliproxy-usage setup again.", "warning");
			return;
		}
		const next = { ...current.settings, managementKey: key };
		if (needsUrl) next.managementUrl = managementUrl;
		await saveSettings(next, current.raw, paths.settingsPath);
		ctx.ui.notify(`CLIProxyAPI management access configured for ${managementUrl}.`, "info");
		await onSaved(next);
	} catch {
		// Filesystem errors may include private paths/content; never echo arbitrary errors.
		ctx.ui.notify("Unable to complete Management setup. Check settings file access and try again.", "error");
	}
}
