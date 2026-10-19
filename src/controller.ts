import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "./abort.js";
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
	resolveManagementSource,
} from "./usage.js";
import { clearUsage, formatDetails, renderUsage } from "./ui.js";
import type { AccountUsage, ProviderName, Settings } from "./types.js";

type RefreshRequest = {
	readonly generation: number;
	ctx: ExtensionContext;
	providers: ProviderName[];
	notifyProviders: ProviderName[];
	force: boolean;
	loaded?: LoadedSettings;
};

type RefreshOperation = {
	readonly generation: number;
	controller: AbortController;
	providers: ProviderName[];
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
	private readonly refreshRequests = new Set<RefreshRequest>();
	private generation = 0;
	private operation: RefreshOperation | undefined;
	private sourceBoundary: { url: string | undefined; key: string } | undefined;
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
			(current, next) => current.generation !== next.generation ? next : ({
				generation: next.generation,
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
		if (!this.active) return false;
		if (this.operation && this.owns(this.operation) && this.operation.providers.includes(provider)) return true;
		return [...this.refreshRequests].some((request) =>
			request.generation === this.generation && request.providers.includes(provider));
	}

	private owns(operation: RefreshOperation): boolean {
		return this.active && this.operation === operation &&
			operation.generation === this.generation && !operation.controller.signal.aborted;
	}

	private invalidateWork(ctx?: ExtensionContext): void {
		this.generation++;
		this.refreshQueue.cancelPending();
		this.refreshRequests.clear();
		const operation = this.operation;
		this.operation = undefined;
		operation?.controller.abort();
		if (ctx?.hasUI) ctx.ui.setStatus("cliproxy-usage", undefined);
	}

	private settingsInvalidateWork(settings: Settings): boolean {
		return settings.managementUrl !== this.settingsSnapshot.managementUrl ||
			settings.managementKey !== this.settingsSnapshot.managementKey ||
			PROVIDERS.some((provider) => settings.providers[provider] !== this.settingsSnapshot.providers[provider]);
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
		const cachedById = new Map<string, AccountUsage>();
		for (const item of this.itemsForProvider(provider)) {
			if (item.error || !item.accountId || (!item.windows.length && !item.balance)) continue;
			cachedById.set(item.accountId, item);
		}
		return items.map((item) => {
			if (!item.error || !item.accountId) return item;
			const cached = cachedById.get(item.accountId);
			return cached ? { ...cached, label: item.label } : item;
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

	private requestRefresh(input: Omit<RefreshRequest, "generation">): Promise<void> {
		if (!this.active) return Promise.resolve();
		const request: RefreshRequest = {
			...input,
			generation: this.generation,
			loaded: input.loaded ? { ...input.loaded, settings: structuredClone(input.loaded.settings) } : undefined,
		};
		this.refreshRequests.add(request);
		this.emitChange();
		return this.refreshQueue.request(request).finally(() => {
			this.refreshRequests.delete(request);
			if (this.active && request.generation === this.generation) this.emitChange();
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
		if (!this.active || request.generation !== this.generation) return;
		const operation: RefreshOperation = {
			generation: request.generation,
			controller: new AbortController(),
			providers: request.providers,
		};
		this.operation = operation;
		try {
			await abortable(this.performRefresh(request, operation), operation.controller.signal);
		} catch (error) {
			if (!this.owns(operation)) return;
			const message = error instanceof Error ? error.message : String(error);
			for (const provider of operation.providers) this.recordProviderFailure(provider, message);
			this.renderCurrentModel(request.ctx);
			this.emitChange();
			if (request.ctx.hasUI) request.ctx.ui.notify(`Failed to refresh CLIProxyAPI usage: ${message}`, "error");
		} finally {
			const current = this.owns(operation);
			if (this.operation === operation) this.operation = undefined;
			if (current) {
				if (request.ctx.hasUI) request.ctx.ui.setStatus("cliproxy-usage", undefined);
				this.emitChange();
			}
		}
	}

	private async performRefresh(request: RefreshRequest, operation: RefreshOperation): Promise<void> {
		const loaded = request.loaded ?? await loadSettings(this.paths.settingsPath, this.paths.legacySettingsPath);
		if (!this.owns(operation)) return;
		const source = await resolveManagementSource(loaded.settings, this.paths.providerConfigPath);
		if (!this.owns(operation)) return;

		const boundaryChanged = this.sourceBoundary !== undefined && (
			this.sourceBoundary.url !== source.managementUrl ||
			this.sourceBoundary.key !== loaded.settings.managementKey
		);
		// Boundary adoption is distinct from the immutable operation generation.
		// There is only one valid operation; obsolete pending work must not follow it.
		if (boundaryChanged || (this.sourceBoundary && this.settingsInvalidateWork(loaded.settings))) {
			this.refreshQueue.cancelPending();
			this.refreshRequests.clear();
		}
		if (boundaryChanged) {
			this.clearAllCaches();
			this.rejectedManagementKey = undefined;
			this.rejectedManagementError = undefined;
		}
		this.sourceBoundary = { url: source.managementUrl, key: loaded.settings.managementKey };
		this.settingsSnapshot = structuredClone(loaded.settings);
		this.maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
		this.notifySettingsWarnings(request.ctx, loaded);
		for (const provider of PROVIDERS) {
			if (!loaded.settings.providers[provider]) this.clearProviderCache(provider);
		}
		operation.providers = request.providers.filter((provider) => loaded.settings.providers[provider]);
		if (!request.force && !request.notifyProviders.length && loaded.settings.managementKey &&
			this.rejectedManagementKey === loaded.settings.managementKey) {
			const message = this.rejectedManagementError || "management authentication failed; run /cliproxy-usage setup";
			for (const provider of operation.providers) this.recordProviderFailure(provider, message);
			this.renderCurrentModel(request.ctx);
			this.emitChange();
			return;
		}

		if (request.ctx.hasUI && operation.providers.length) {
			request.ctx.ui.setStatus("cliproxy-usage", request.ctx.ui.theme.fg("dim", "quota refreshing…"));
		}
		const results = operation.providers.length
			? await readAccounts(loaded.settings, { source, providers: operation.providers, signal: operation.controller.signal })
			: { providers: [], managementAuthFailed: false };
		if (!this.owns(operation)) return;
		for (const result of results.providers) {
			const { provider } = result;
			if (result.discovery === "failure") {
				this.recordProviderFailure(provider, result.error);
				continue;
			}
			const failed = result.items.filter((item) => item.error);
			const allFailed = result.items.length > 0 && failed.length === result.items.length;
			const failure = [...new Set(failed.map((item) => `${item.label}: ${item.error}`))].join("; ");
			// Successful discovery is authoritative, even when every query failed.
			this.replaceProviderItems(provider, this.mergeFailedAccountItems(provider, result.items));
			if (!allFailed) {
				this.fetchedProviders.add(provider);
				this.lastUpdated.set(provider, new Date());
			}
			if (failure) this.lastRefreshErrors.set(provider, failure);
			else this.lastRefreshErrors.delete(provider);
		}
		this.rejectedManagementKey = results.managementAuthFailed ? loaded.settings.managementKey : undefined;
		this.rejectedManagementError = results.managementAuthFailed
			? "management authentication failed; run /cliproxy-usage setup"
			: undefined;
		this.renderCurrentModel(request.ctx);
		this.emitChange();
		for (const provider of request.notifyProviders) this.notifyProviderState(request.ctx, provider);
	}

	private reportBackgroundError(
		ctx: ExtensionContext,
		promise: Promise<void>,
	): void {
		const generation = this.generation;
		void promise.catch((error) => {
			if (this.active && generation === this.generation && ctx.hasUI) {
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
		if (!this.active) return Promise.resolve();
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
		if (!this.active) return;
		const generation = this.generation;
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
						if (!this.active || generation !== this.generation) return;
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
					if (!this.active || generation !== this.generation) return;
					component.invalidate();
					tui.requestRender();
				});
				queueMicrotask(() => {
					if (
						!closed &&
						this.active && generation === this.generation &&
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
		this.invalidateWork(ctx);
		this.clearAllCaches();
		this.sourceBoundary = undefined;
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
		this.lastSettingsWarning = undefined;
		this.active = true;
		this.settingsSnapshot = structuredClone(loaded.settings);
		this.maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
		this.scheduleRefresh(ctx, loaded.settings.refreshMinutes);
		this.reportBackgroundError(ctx, this.refreshCurrent(ctx, { loaded }));
	}

	shutdown(ctx: ExtensionContext): void {
		this.active = false;
		this.invalidateWork();
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.clearAllCaches();
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
		this.lastSettingsWarning = undefined;
		this.sourceBoundary = undefined;
		this.changeListeners.clear();
		clearUsage(ctx);
	}

	modelSelected(
		ctx: ExtensionContext,
		provider: ProviderName | undefined,
	): void {
		if (!this.active) return;
		renderUsage(
			ctx,
			provider && this.settingsSnapshot.providers[provider] ? this.itemsForProvider(provider) : [],
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
		if (!this.active) return;
		if (this.settingsInvalidateWork(settings)) this.invalidateWork(ctx);
		this.settingsSnapshot = structuredClone(settings);
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
		this.sourceBoundary = undefined;
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
		this.renderCurrentModel(ctx);
		await this.refreshCurrent(ctx, { force: true });
	}

	resetSettings(settings: Settings, ctx?: ExtensionContext): void {
		this.invalidateWork(ctx);
		this.settingsSnapshot = structuredClone(settings);
		this.clearAllCaches();
		this.sourceBoundary = undefined;
		this.rejectedManagementKey = undefined;
		this.rejectedManagementError = undefined;
		if (ctx) this.renderCurrentModel(ctx);
		this.emitChange();
	}

	syncSettings(settings: Settings, ctx?: ExtensionContext): void {
		const sourceChanged = settings.managementUrl !== this.settingsSnapshot.managementUrl ||
			settings.managementKey !== this.settingsSnapshot.managementKey;
		if (this.settingsInvalidateWork(settings)) this.invalidateWork(ctx);
		if (sourceChanged) {
			this.clearAllCaches();
			this.sourceBoundary = undefined;
			this.rejectedManagementKey = undefined;
			this.rejectedManagementError = undefined;
		}
		for (const provider of PROVIDERS) if (!settings.providers[provider]) this.clearProviderCache(provider);
		this.settingsSnapshot = structuredClone(settings);
		this.maxVisibleAccounts = settings.maxVisibleAccounts;
		if (ctx) this.renderCurrentModel(ctx);
		this.emitChange();
	}

	lastRefresh(provider: ProviderName | undefined): Date | undefined {
		return provider ? this.lastUpdated.get(provider) : undefined;
	}
}
