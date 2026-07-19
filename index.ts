import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { loadSettings } from "./src/settings.js";
import { showSettings } from "./src/settings-ui.js";
import { readAccounts } from "./src/usage.js";
import { clearUsage, formatDetails, renderUsage } from "./src/ui.js";
import type { Settings } from "./src/types.js";

const commands = ["settings", "status", "help", "config"];
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

	const refresh = (ctx: ExtensionContext, notify = false) =>
		(refreshing ??= (async () => {
			const loaded = await loadSettings(SETTINGS_PATH, LEGACY_SETTINGS_PATH);
			if (loaded.warnings.length && ctx.hasUI) {
				ctx.ui.notify(loaded.warnings.join("; "), "warning");
			}
			const items = await readAccounts(loaded.settings);
			renderUsage(ctx, items);
			if (notify) {
				ctx.ui.notify(
					formatDetails(items),
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

	const applySettings = async (ctx: ExtensionContext, settings: Settings) => {
		scheduleRefresh(ctx, settings.refreshMinutes);
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

	pi.on("session_shutdown", (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		clearUsage(ctx);
	});

	pi.registerCommand("cliproxy-usage", {
		description: "Refresh usage or manage extension settings",
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
			if (action === "settings" || action === "config") {
				return showSettings(
					ctx,
					SETTINGS_PATH,
					LEGACY_SETTINGS_PATH,
					(settings) => applySettings(ctx, settings),
				);
			}
			if (action === "status") return showStatus(ctx);
			if (action === "help") {
				ctx.ui.notify(
					[
						"/cliproxy-usage — refresh usage",
						"/cliproxy-usage settings — edit settings",
						"/cliproxy-usage status — show effective settings",
						"/cliproxy-usage help — show this help",
						`Manual settings: ${SETTINGS_PATH}`,
					].join("\n"),
					"info",
				);
				return;
			}
			ctx.ui.notify(
				`Usage: /cliproxy-usage [${commands.join("|")}]`,
				"warning",
			);
		},
	});
}
