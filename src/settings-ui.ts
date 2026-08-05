import {
	type ExtensionCommandContext,
	getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import { PROVIDERS, PROVIDER_LABELS } from "./providers.js";
import { loadSettings, saveSettings } from "./settings.js";
import type { ProviderName, Settings } from "./types.js";

const providerIds = new Set<ProviderName>(PROVIDERS);

class PasswordInput extends Input {
	override render(width: number): string[] {
		const value = this.getValue();
		this.setValue("•".repeat(value.length));
		try {
			return super.render(width);
		} finally {
			this.setValue(value);
		}
	}
}

export async function promptManagementKey(
	ctx: ExtensionCommandContext,
	managementUrl: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Management setup requires an interactive TUI session.",
				"warning",
			);
		}
		return undefined;
	}

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold("CLIProxyAPI Management Setup")),
				1,
				1,
			),
		);
		container.addChild(
			new Text(
				`${theme.fg("dim", "Endpoint:")} ${managementUrl}\n${theme.fg("muted", "Enter the password used by management.html")}`,
				1,
				0,
			),
		);
		const input = new PasswordInput();
		input.focused = true;
		input.onSubmit = (value) => done(value || undefined);
		input.onEscape = () => done(undefined);
		container.addChild(input);
		container.addChild(
			new Text(theme.fg("dim", "enter save • esc cancel"), 1, 1),
		);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				input.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

export function settingsSummary(settings: Settings, settingsPath: string): string {
	return `Management URL: ${settings.managementUrl || "automatic"}\nManagement key: ${settings.managementKey ? "configured" : "run /cliproxy-usage setup"}\n${settingsPath}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function settingValue(settings: Settings, id: string): string {
	if (id === "managementUrl") return settings.managementUrl || "automatic";
	if (id === "refreshMinutes") return String(settings.refreshMinutes);
	if (id === "maxVisibleAccounts") {
		return String(settings.maxVisibleAccounts);
	}
	return settings.providers[id as ProviderName] ? "enabled" : "disabled";
}

export async function showSettings(
	ctx: ExtensionCommandContext,
	settingsPath: string,
	legacySettingsPath: string,
	onChange: (settings: Settings, changedId: string) => Promise<void>,
): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI)
			ctx.ui.notify(`Edit settings manually: ${settingsPath}`, "info");
		return;
	}

	const loaded = await loadSettings(settingsPath, legacySettingsPath);
	if (!loaded.writable) {
		ctx.ui.notify(
			`Cannot edit invalid settings: ${loaded.warnings.join(", ")}`,
			"error",
		);
		return;
	}
	let settings = loaded.settings;
	let persistedSettings = structuredClone(loaded.settings);
	let raw = loaded.raw;
	let saveQueue = Promise.resolve();
	let revision = 0;

	await ctx.ui.custom((tui, theme, _keybindings, done) => {
		const items: SettingItem[] = [
			{
				id: "managementUrl",
				label: "Management URL override",
				description: "Empty uses the base URL from cliproxyapi.json",
				currentValue: settings.managementUrl || "automatic",
				submenu: (_currentValue, close) => {
					const input = new Input();
					input.setValue(settings.managementUrl);
					input.onSubmit = (value) => close(value.trim() || "automatic");
					input.onEscape = () => close(undefined);
					return input;
				},
			},
			{
				id: "refreshMinutes",
				label: "Refresh interval (min)",
				description: "Minutes between automatic usage refreshes",
				currentValue: String(settings.refreshMinutes),
				values: ["1", "5", "10", "15", "30", "60"],
			},
			{
				id: "maxVisibleAccounts",
				label: "Visible accounts",
				description: "Maximum account rows shown below editor",
				currentValue: String(settings.maxVisibleAccounts),
				values: ["1", "2", "3", "4", "5", "10"],
			},
			...PROVIDERS.map((provider) => ({
				id: provider,
				label: PROVIDER_LABELS[provider],
				description: `Show ${PROVIDER_LABELS[provider]} accounts`,
				currentValue: settings.providers[provider] ? "enabled" : "disabled",
				values: ["enabled", "disabled"],
			})),
		];
		const container = new Container();
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold("CLIProxyAPI Usage Settings")),
				1,
				1,
			),
		);
		const summary = new Text("", 1, 1);
		const updateSummary = () => {
			summary.setText(theme.fg("dim", settingsSummary(settings, settingsPath)));
		};
		updateSummary();
		let list: SettingsList;
		const restorePersistedValues = () => {
			settings = structuredClone(persistedSettings);
			for (const item of items) {
				list.updateValue(item.id, settingValue(settings, item.id));
			}
			updateSummary();
		};
		list = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, value) => {
				const changeRevision = ++revision;
				if (id === "managementUrl") {
					settings.managementUrl = value === "automatic" ? "" : value;
				}
				if (id === "refreshMinutes") settings.refreshMinutes = Number(value);
				if (id === "maxVisibleAccounts") {
					settings.maxVisibleAccounts = Number(value);
				}
				if (providerIds.has(id as ProviderName)) {
					settings.providers[id as ProviderName] = value === "enabled";
				}
				updateSummary();
				tui.requestRender();
				const next = structuredClone(settings);
				saveQueue = saveQueue.then(async () => {
					try {
						raw = await saveSettings(next, raw, settingsPath);
						persistedSettings = next;
					} catch (error) {
						if (changeRevision === revision) restorePersistedValues();
						ctx.ui.notify(`Failed to save settings: ${errorMessage(error)}`, "error");
						tui.requestRender();
						return;
					}
					try {
						await onChange(next, id);
					} catch (error) {
						ctx.ui.notify(
							`Settings saved, but failed to apply: ${errorMessage(error)}`,
							"error",
						);
					}
				});
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		container.addChild(summary);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => {
				updateSummary();
				container.invalidate();
			},
			handleInput(data: string) {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
	await saveQueue;
}
