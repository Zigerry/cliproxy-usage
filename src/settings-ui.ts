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
import { loadSettings, saveSettings } from "./settings.js";
import type { ProviderName, Settings } from "./types.js";

const providers = ["claude", "codex", "deepseek", "grok", "kimi"] as const;
const providerIds = new Set<ProviderName>(providers);
const providerLabels: Record<ProviderName, string> = {
	claude: "Claude",
	codex: "Codex",
	deepseek: "DeepSeek",
	grok: "Grok",
	kimi: "Kimi",
};

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
	let raw = loaded.raw;
	let saveQueue = Promise.resolve();

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
			...providers.map((provider) => ({
				id: provider,
				label: providerLabels[provider],
				description: `Show ${provider} accounts`,
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
		const list = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, value) => {
				const previous = structuredClone(settings);
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
				const next = structuredClone(settings);
				saveQueue = saveQueue
					.then(async () => {
						raw = await saveSettings(next, raw, settingsPath);
						await onChange(next, id);
					})
					.catch((error) => {
						settings = previous;
						let previousValue: string;
						if (id === "managementUrl") {
							previousValue = previous.managementUrl || "automatic";
						} else if (id === "refreshMinutes") {
							previousValue = String(previous.refreshMinutes);
						} else if (id === "maxVisibleAccounts") {
							previousValue = String(previous.maxVisibleAccounts);
						} else {
							previousValue = previous.providers[id as ProviderName]
								? "enabled"
								: "disabled";
						}
						list.updateValue(id, previousValue);
						ctx.ui.notify(`Failed to save settings: ${error.message}`, "error");
						tui.requestRender();
					});
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		container.addChild(
			new Text(
				theme.fg(
					"dim",
					`Management URL: ${settings.managementUrl || "automatic"}\nManagement key: ${settings.managementKey ? "configured" : "run /cliproxy-usage setup"}\n${settingsPath}`,
				),
				1,
				1,
			),
		);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
	await saveQueue;
}
