import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { UsageDetailsComponent } from "./details-ui.js";
import { PROVIDERS, PROVIDER_LABELS } from "./providers.js";
import { CoalescingAsyncQueue } from "./refresh.js";
import {
	DEFAULT_SETTINGS,
	type LoadedSettings,
	loadSettings,
} from "./settings.js";
import {
	accountsForModel,
	providerForModel,
	readAccounts,
} from "./usage.js";
import { clearUsage, formatDetails, renderUsage } from "./ui.js";
import type { AccountUsage, ProviderName, Settings } from "./types.js";

type RefreshRequest = {
	ctx: ExtensionContext;
	providers: ProviderName[];
	notifyProviders: ProviderName[];
	force: boolean;
	loaded?: LoadedSettings;
};

type UsageControllerPaths = {
	settingsPath: string;
	legacySettingsPath: string;
	providerConfigPath: string;
};

function uniqueProviders(...groups: ProviderName[][]): ProviderName[] {
	return [...new Set(groups.flat())];
}

export class UsageController {
	private timer: ReturnType<typeof setInterval> | undefined;
	private latestItems: AccountUsage[] = [];
	private fetchedProviders = new Set<ProviderName>();
	private lastUpdated = new Map<ProviderName, Date>();
	private lastRefreshErrors = new Map<ProviderName, string>();
	private refreshingProviders = new Map<ProviderName, number>();
	private readonly changeListeners = new Set<() => void>();
	private maxVisibleAccounts = DEFAULT_SETTINGS.maxVisibleAccounts;
	private settingsSnapshot: Settings = structuredClone(DEFAULT_SETTINGS);
	private rejectedManagementKey: string | undefined;
	private rejectedManagementError: string | undefined;
	private lastSettingsWarning: string | undefined;
	private active = true;
	private readonly refreshQueue: CoalescingAsyncQueue<RefreshRequest>;

	constructor(private readonly paths: UsageControllerPaths) {
		this.refreshQueue = new CoalescingAsyncQueue<RefreshRequest>(
			(current, next) => ({
				ctx: next.ctx,
				providers: uniqueProviders(current.providers, next.providers),
				notifyProviders: uniqueProviders(
					current.notifyProviders,
					next.notifyProviders,
				),
				force: current.force || next.force,
				loaded: next.loaded ?? current.loaded,
			}),
			(request) => this.runRefresh(request),
		);
	}

	private providerForContext(ctx: ExtensionContext): ProviderName | undefined {
		return ctx.model
			? providerForModel(ctx.model.provider, ctx.model.id)
			: undefined;
	}

	private itemsForProvider(provider?: ProviderName): AccountUsage[] {
		return provider
			? this.latestItems.filter((item) => item.provider === provider)
			: [];
	}

	private itemsForCurrentModel(ctx: ExtensionContext): AccountUsage[] {
		if (!ctx.model) return [];
		return accountsForModel(
			this.latestItems,
			ctx.model.provider,
			ctx.model.id,
		);
	}

	private providerIsRefreshing(provider: ProviderName): boolean {
		return (this.refreshingProviders.get(provider) ?? 0) > 0;
	}

	private providerIsStale(provider: ProviderName): boolean {
		if (!this.fetchedProviders.has(provider)) return true;
		const updatedAt = this.lastUpdated.get(provider)?.getTime() ?? 0;
		return (
			Date.now() - updatedAt >=
			this.settingsSnapshot.refreshMinutes * 60_000
		);
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) listener();
	}

	private subscribe(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private replaceProviderItems(
		provider: ProviderName,
		items: AccountUsage[],
	): void {
		this.latestItems = this.latestItems.filter(
			(item) => item.provider !== provider,
		);
		this.latestItems.push(...items);
	}

	private mergeFailedAccountItems(
		provider: ProviderName,
		items: AccountUsage[],
	): AccountUsage[] {
		const cachedByLabel = new Map<string, AccountUsage[]>();
		for (const item of this.itemsForProvider(provider)) {
			if (item.error) continue;
			const matches = cachedByLabel.get(item.label) ?? [];
			matches.push(item);
			cachedByLabel.set(item.label, matches);
		}
		return items.map((item) => {
			if (!item.error) return item;
			const matches = cachedByLabel.get(item.label);
			return matches?.shift() ?? item;
		});
	}

	private recordProviderFailure(
		provider: ProviderName,
		message: string,
		items: AccountUsage[] = [],
	): void {
		this.lastRefreshErrors.set(provider, message);
		if (!this.fetchedProviders.has(provider)) {
			this.replaceProviderItems(
				provider,
				items.length
					? items
					: [{ provider, label: "remote", windows: [], error: message }],
			);
		}
	}

	private requestRefresh(request: RefreshRequest): Promise<void> {
		for (const provider of request.providers) {
			this.refreshingProviders.set(
				provider,
				(this.refreshingProviders.get(provider) ?? 0) + 1,
			);
		}
		this.emitChange();
		return this.refreshQueue.request(request).finally(() => {
			for (const provider of request.providers) {
				const remaining =
					(this.refreshingProviders.get(provider) ?? 1) - 1;
				if (remaining > 0) {
					this.refreshingProviders.set(provider, remaining);
				} else {
					this.refreshingProviders.delete(provider);
				}
			}
			this.emitChange();
		});
	}

	renderCurrentModel(ctx: ExtensionContext): void {
		renderUsage(
			ctx,
			this.itemsForCurrentModel(ctx),
			this.maxVisibleAccounts,
		);
	}

	private clearProviderCache(provider: ProviderName): void {
		this.latestItems = this.latestItems.filter(
			(item) => item.provider !== provider,
		);
		this.fetchedProviders.delete(provider);
		this.lastUpdated.delete(provider);
		this.lastRefreshErrors.delete(provider);
	}

	private clearAllCaches(): void {
		this.latestItems = [];
		this.fetchedProviders = new Set<ProviderName>();
		this.lastUpdated = new Map<ProviderName, Date>();
		this.lastRefreshErrors = new Map<ProviderName, string>();
	}

	private notifySettingsWarnings(
		ctx: ExtensionContext,
		loaded: LoadedSettings,
	): void {
		const warning = loaded.warnings.join("; ");
		if (!warning) {
			this.lastSettingsWarning = undefined;
			return;
		}
		if (ctx.hasUI && warning !== this.lastSettingsWarning) {
			ctx.ui.notify(warning, "warning");
		}
		this.lastSettingsWarning = warning;
	}

	private modelDescription(ctx: ExtensionContext): string {
		return ctx.model
			? `${ctx.model.provider}/${ctx.model.id}`
			: "the current model";
	}

	private notifyProviderState(
		ctx: ExtensionContext,
		provider: ProviderName,
	): void {
		const label = PROVIDER_LABELS[provider];
		if (!this.settingsSnapshot.providers[provider]) {
			ctx.ui.notify(
				`${label} usage is disabled. Enable it in /cliproxy-usage settings.`,
				"warning",
			);
			return;
		}
		const items = this.itemsForProvider(provider);
		const refreshError = this.lastRefreshErrors.get(provider);
		if (refreshError) {
			ctx.ui.notify(
				items.length && this.fetchedProviders.has(provider)
					? `${formatDetails(items)}\nRefresh failed: ${refreshError}`
					: `Failed to refresh ${label} usage: ${refreshError}`,
				"warning",
			);
			return;
		}
		if (!this.fetchedProviders.has(provider)) {
			ctx.ui.notify(
				`No cached ${label} usage. Run /cliproxy-usage to refresh.`,
				"info",
			);
			return;
		}
		if (!items.length) {
			ctx.ui.notify(`No ${label} CLIProxyAPI accounts found.`, "info");
			return;
		}
		ctx.ui.notify(
			formatDetails(items),
			items.some((item) => item.error) ? "warning" : "info",
		);
	}

	private async runRefresh(request: RefreshRequest): Promise<void> {
		if (!this.active) return;
		let loaded: LoadedSettings;
		try {
			loaded =
				request.loaded ??
				(await loadSettings(
					this.paths.settingsPath,
					this.paths.legacySettingsPath,
				));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			for (const provider of request.providers) {
				this.recordProviderFailure(provider, message);
			}
			this.emitChange();
			if (request.ctx.hasUI) {
				request.ctx.ui.notify(
					`Failed to load CLIProxyAPI usage settings: ${message}`,
					"error",
				);
			}
			return;
		}
		if (!this.active) return;
		this.settingsSnapshot = loaded.settings;
		this.maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
		this.notifySettingsWarnings(request.ctx, loaded);

		for (const provider of request.providers) {
			if (!loaded.settings.providers[provider]) {
				this.clearProviderCache(provider);
			}
		}
		const enabledProviders = request.providers.filter(
			(provider) => loaded.settings.providers[provider],
		);
		if (
			!request.force &&
			!request.notifyProviders.length &&
			loaded.settings.managementKey &&
			this.rejectedManagementKey === loaded.settings.managementKey
		) {
			const message =
				this.rejectedManagementError ||
				"management authentication failed; run /cliproxy-usage setup";
			for (const provider of enabledProviders) {
				this.recordProviderFailure(provider, message);
			}
			this.renderCurrentModel(request.ctx);
			this.emitChange();
			return;
		}

		if (request.ctx.hasUI && enabledProviders.length) {
			request.ctx.ui.setStatus(
				"cliproxy-usage",
				request.ctx.ui.theme.fg("dim", "quota refreshing…"),
			);
		}
		try {
			let managementAuthFailed = false;
			const providerFailures = new Map<ProviderName, string>();
			const results = enabledProviders.length
				? await readAccounts(loaded.settings, {
						providerConfigPath: this.paths.providerConfigPath,
						providers: enabledProviders,
						onManagementAuthFailure: () => {
							managementAuthFailed = true;
						},
						onProviderFailure: (provider, message) => {
							providerFailures.set(provider, message);
						},
					})
				: [];
			if (!this.active) return;
			for (const provider of enabledProviders) {
				const providerItems = results.filter(
					(item) => item.provider === provider,
				);
				const failedItems = providerItems.filter(
					(item): item is AccountUsage & { error: string } =>
						Boolean(item.error),
				);
				const allAccountsFailed =
					providerItems.length > 0 &&
					failedItems.length === providerItems.length;
				const providerFailure = providerFailures.get(provider);
				const failure = providerFailure
					? providerFailure
					: [
							...new Set(
								failedItems.map(
									(item) => `${item.label}: ${item.error}`,
								),
							),
						].join("; ");
				if ((providerFailures.has(provider) && !providerItems.length) || allAccountsFailed) {
					this.recordProviderFailure(provider, failure, providerItems);
					continue;
				}
				this.replaceProviderItems(
					provider,
					failedItems.length
						? this.mergeFailedAccountItems(provider, providerItems)
						: providerItems,
				);
				this.fetchedProviders.add(provider);
				this.lastUpdated.set(provider, new Date());
				if (failure) {
					this.lastRefreshErrors.set(provider, failure);
				} else {
					this.lastRefreshErrors.delete(provider);
				}
			}
			this.rejectedManagementKey = managementAuthFailed
				? loaded.settings.managementKey
				: undefined;
			this.rejectedManagementError = managementAuthFailed
				? results.find((item) => item.error)?.error
				: undefined;
			this.renderCurrentModel(request.ctx);
			this.emitChange();
			for (const provider of request.notifyProviders) {
				this.notifyProviderState(request.ctx, provider);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			for (const provider of enabledProviders) {
				this.recordProviderFailure(provider, message);
			}
			this.renderCurrentModel(request.ctx);
			this.emitChange();
			if (request.ctx.hasUI) {
				request.ctx.ui.notify(
					`Failed to refresh CLIProxyAPI usage: ${message}`,
					"error",
				);
			}
		} finally {
			if (request.ctx.hasUI) {
				request.ctx.ui.setStatus("cliproxy-usage", undefined);
			}
		}
	}

	private reportBackgroundError(
		ctx: ExtensionContext,
		promise: Promise<void>,
	): void {
		void promise.catch((error) => {
			if (this.active && ctx.hasUI) {
				ctx.ui.notify(
					`CLIProxyAPI usage refresh failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		});
	}

	refreshCurrent(
		ctx: ExtensionContext,
		options: {
			notify?: boolean;
			force?: boolean;
			loaded?: LoadedSettings;
		} = {},
	): Promise<void> {
		const provider = this.providerForContext(ctx);
		if (!provider) {
			if (options.loaded) {
				return this.requestRefresh({
					ctx,
					providers: [],
					notifyProviders: [],
					force: Boolean(options.force),
					loaded: options.loaded,
				});
			}
			if (options.notify) {
				ctx.ui.notify(
					ctx.model
						? `${this.modelDescription(ctx)} has no supported CLIProxyAPI usage source.`
						: "No active Pi model is selected.",
					"info",
				);
			}
			this.renderCurrentModel(ctx);
			return Promise.resolve();
		}
		return this.requestRefresh({
			ctx,
			providers: [provider],
			notifyProviders: options.notify ? [provider] : [],
			force: Boolean(options.force),
			loaded: options.loaded,
		});
	}

	async showDetails(ctx: ExtensionCommandContext): Promise<void> {
		const provider = this.providerForContext(ctx);
		if (!provider) {
			ctx.ui.notify(
				ctx.model
					? `${this.modelDescription(ctx)} has no supported CLIProxyAPI usage source.`
					: "No active Pi model is selected.",
				"info",
			);
			this.renderCurrentModel(ctx);
			return;
		}
		if (!this.settingsSnapshot.providers[provider]) {
			ctx.ui.notify(
				`${PROVIDER_LABELS[provider]} usage is disabled. Enable it in /cliproxy-usage settings.`,
				"warning",
			);
			return;
		}
		if (ctx.mode !== "tui") {
			await this.refreshCurrent(ctx, { notify: true });
			return;
		}

		await ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				let closed = false;
				let unsubscribe = () => {};
				const close = () => {
					if (closed) return;
					closed = true;
					done();
				};
				const component = new UsageDetailsComponent(tui, theme, {
					getItems: () => {
						const items = this.itemsForProvider(provider);
						const error = this.lastRefreshErrors.get(provider);
						return !this.fetchedProviders.has(provider) &&
							error &&
							items.every((item) => item.error)
							? []
							: items;
					},
					hasFetched: () => this.fetchedProviders.has(provider),
					isRefreshing: () => this.providerIsRefreshing(provider),
					getError: () => this.lastRefreshErrors.get(provider),
					onRefresh: () => {
						this.reportBackgroundError(
							ctx,
							this.refreshCurrent(ctx, { force: true }),
						);
					},
					onClose: close,
					onDispose: () => {
						closed = true;
						unsubscribe();
					},
				});
				unsubscribe = this.subscribe(() => {
					component.invalidate();
					tui.requestRender();
				});
				queueMicrotask(() => {
					if (
						!closed &&
						this.active &&
						this.providerIsStale(provider) &&
						!this.providerIsRefreshing(provider)
					) {
						this.reportBackgroundError(ctx, this.refreshCurrent(ctx));
					}
				});
				return component;
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: 80,
					maxHeight: "100%",
				},
			},
		);
	}

	private scheduleRefresh(ctx: ExtensionContext, minutes: number): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = setInterval(() => {
			this.reportBackgroundError(ctx, this.refreshCurrent(ctx));
		}, minutes * 60_000);
		this.timer.unref?.();
	}

	start(ctx: ExtensionContext, loaded: LoadedSettings): void {
		this.active = true;
		this.settingsSnapshot = loaded.settings;
		this.maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
		this.scheduleRefresh(ctx, loaded.settings.refreshMinutes);
		this.reportBackgroundError(ctx, this.refreshCurrent(ctx, { loaded }));
	}

	shutdown(ctx: ExtensionContext): void {
		this.active = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.clearAllCaches();
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
		this.lastSettingsWarning = undefined;
		clearUsage(ctx);
	}

	modelSelected(
		ctx: ExtensionContext,
		provider: ProviderName | undefined,
	): void {
		renderUsage(
			ctx,
			this.itemsForProvider(provider),
			this.maxVisibleAccounts,
		);
		if (!provider || !this.settingsSnapshot.providers[provider]) return;
		if (
			this.providerIsStale(provider) &&
			!this.providerIsRefreshing(provider)
		) {
			this.reportBackgroundError(
				ctx,
				this.requestRefresh({
					ctx,
					providers: [provider],
					notifyProviders: [],
					force: false,
				}),
			);
		}
	}

	async applySettings(
		ctx: ExtensionContext,
		settings: Settings,
		changedId: string,
	): Promise<void> {
		this.settingsSnapshot = settings;
		this.scheduleRefresh(ctx, settings.refreshMinutes);
		if (changedId === "maxVisibleAccounts") {
			this.maxVisibleAccounts = settings.maxVisibleAccounts;
			this.renderCurrentModel(ctx);
			return;
		}
		if (changedId === "refreshMinutes") return;
		if ((PROVIDERS as readonly string[]).includes(changedId)) {
			const provider = changedId as ProviderName;
			if (!settings.providers[provider]) {
				this.clearProviderCache(provider);
				this.renderCurrentModel(ctx);
				return;
			}
			if (this.providerForContext(ctx) === provider) {
				await this.refreshCurrent(ctx);
			}
			return;
		}
		this.clearAllCaches();
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
		await this.refreshCurrent(ctx, { force: true });
	}

	resetSettings(settings: Settings): void {
		this.settingsSnapshot = settings;
		this.clearAllCaches();
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
	}

	syncSettings(settings: Settings): void {
		this.settingsSnapshot = settings;
	}

	lastRefresh(provider: ProviderName | undefined): Date | undefined {
		return provider ? this.lastUpdated.get(provider) : undefined;
	}
}
