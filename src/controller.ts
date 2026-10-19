import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { abortable } from "./abort.js";
import { UsageDetailsComponent } from "./details-ui.js";
import { PROVIDERS, PROVIDER_LABELS } from "./providers.js";
import { CoalescingAsyncQueue } from "./refresh.js";
import { deriveEligibility, isEligible, updateRetry } from "./retry.js";
import {
	DEFAULT_SETTINGS,
	type LoadedSettings,
	loadSettings,
} from "./settings.js";
import {
	providerForModel,
	readAccounts,
	resolveManagementSource,
	type ManagementSource,
} from "./usage.js";
import { applyProviderRead, beginProviderRead, deriveUsageSnapshot, nextFreshnessDeadline, safeUsageText } from "./state.js";
import { clearUsage, formatSnapshotDetails, renderUsage } from "./ui.js";
import type { ProviderName, ProviderUsageState, RetryState, Settings, UsageConfiguration, UsageSnapshot } from "./types.js";

type RefreshRequest = {
	readonly generation: number;
	readonly displayRevision: number;
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
	private refreshContext: ExtensionContext | undefined;
	private nextAutomaticCheckAt: number | undefined;
	private managementRetry: RetryState | undefined;
	private readonly providerStates = new Map<ProviderName, ProviderUsageState>();
	private settingsKnown = false;
	private ageTimer: ReturnType<typeof setTimeout> | undefined;
	private ageOwner: { ctx: ExtensionContext; generation: number } | undefined;
	private readonly detailsViews = new Set<{ provider: ProviderName; close: () => void }>();
	private readonly refreshRequests = new Set<RefreshRequest>();
	private generation = 0;
	private displayRevision = 0;
	private operation: RefreshOperation | undefined;
	private sourceBoundary: { source: ManagementSource; key: string } | undefined;
	private readonly changeListeners = new Set<() => void>();
	private maxVisibleAccounts = DEFAULT_SETTINGS.maxVisibleAccounts;
	private settingsSnapshot: Settings = structuredClone(DEFAULT_SETTINGS);
	private rejectedManagementKey: string | undefined;
	private lastSettingsWarning: string | undefined;
	private active = true;
	private readonly refreshQueue: CoalescingAsyncQueue<RefreshRequest>;

	constructor(private readonly paths: UsageControllerPaths) {
		this.refreshQueue = new CoalescingAsyncQueue<RefreshRequest>(
			(current, next) => current.generation !== next.generation ? next : ({
				generation: next.generation,
				// Keep inherited loaded settings paired with their original display revision.
				displayRevision: next.loaded ? next.displayRevision : current.loaded ? current.displayRevision : next.displayRevision,
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

	private adoptSettings(settings: Settings, observedDisplayRevision?: number): void {
		const next = structuredClone(settings);
		if (observedDisplayRevision !== undefined && observedDisplayRevision !== this.displayRevision) {
			next.showWidget = this.settingsSnapshot.showWidget;
		}
		if (next.showWidget !== this.settingsSnapshot.showWidget) this.displayRevision++;
		this.settingsSnapshot = next;
		if (!next.showWidget) this.clearAgeTimer();
	}

	private providerForContext(ctx: ExtensionContext): ProviderName | undefined {
		return ctx.model
			? providerForModel(ctx.model.provider, ctx.model.id)
			: undefined;
	}

	private configuration(): UsageConfiguration {
		if (!this.settingsKnown) return { status: "pending" };
		if (!this.settingsSnapshot.managementKey) return { status: "setup-required", reason: "missing-key" };
		if (!this.sourceBoundary) return { status: "pending" };
		if (this.sourceBoundary.source.error) return { status: "setup-required", reason: "invalid-source" };
		if (!this.sourceBoundary.source.managementUrl) return { status: "setup-required", reason: "missing-url" };
		if (this.rejectedManagementKey === this.settingsSnapshot.managementKey) return { status: "setup-required", reason: "rejected" };
		return { status: "ready" };
	}

	private snapshotForProvider(provider?: ProviderName, now = Date.now()): UsageSnapshot {
		const configuration = this.configuration();
		const nextCheck = this.active && this.timer && this.refreshContext && provider &&
			this.providerForContext(this.refreshContext) === provider && this.settingsSnapshot.providers[provider] &&
			configuration.status === "ready" ? this.nextAutomaticCheckAt : undefined;
		const eligibility = provider && this.settingsSnapshot.providers[provider]
			? deriveEligibility(this.managementRetry, this.providerStates.get(provider)?.retry, now, nextCheck) : undefined;
		return { ...deriveUsageSnapshot({
			provider,
			enabled: Boolean(provider && this.settingsSnapshot.providers[provider]),
			configuration,
			record: provider ? this.providerStates.get(provider) : undefined,
			refreshing: Boolean(provider && this.providerIsRefreshing(provider)),
			now,
			maxAgeMs: this.settingsSnapshot.refreshMinutes * 60_000,
		}), ...(eligibility ? { eligibility } : {}) };
	}

	getSnapshot(ctx: ExtensionContext, now = Date.now()): UsageSnapshot {
		return this.snapshotForProvider(this.active ? this.providerForContext(ctx) : undefined, now);
	}

	private closeDetails(keepProvider?: ProviderName): void {
		for (const view of [...this.detailsViews]) {
			if (!keepProvider || view.provider !== keepProvider) view.close();
		}
	}

	private clearAgeTimer(): void {
		if (this.ageTimer) clearTimeout(this.ageTimer);
		this.ageTimer = undefined;
		this.ageOwner = undefined;
	}

	private scheduleExpiry(ctx: ExtensionContext, snapshot: UsageSnapshot): void {
		this.clearAgeTimer();
		if (!this.active || ctx.mode !== "tui" || !snapshot.provider ||
			["unsupported", "disabled"].includes(snapshot.state)) return;
		const now = snapshot.generatedAt;
		const candidates = [nextFreshnessDeadline(this.providerStates.get(snapshot.provider), now,
			this.settingsSnapshot.refreshMinutes * 60_000), snapshot.eligibility?.manualAllowedAt,
			snapshot.eligibility?.automaticAllowedAt].filter((at): at is number => at !== undefined && Number.isFinite(at) && at > now);
		if (!candidates.length) return;
		const deadline = Math.min(...candidates);
		const owner = { ctx, generation: this.generation };
		this.ageOwner = owner;
		this.ageTimer = setTimeout(() => {
			if (!this.active || owner.generation !== this.generation || this.ageOwner !== owner) return;
			this.ageTimer = undefined;
			this.renderCurrentModel(owner.ctx);
			this.emitChange();
		}, Math.max(1, Math.min(deadline - Date.now(), 2_147_483_647)));
		this.ageTimer.unref?.();
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
		this.closeDetails();
		this.clearAgeTimer();
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
		const state = this.providerStates.get(provider);
		if (!state?.discovery) return true;
		const snapshot = this.snapshotForProvider(provider);
		return snapshot.stale || snapshot.partial || snapshot.state === "unknown" || snapshot.state === "error" ||
			Date.now() - state.discovery.at >= this.settingsSnapshot.refreshMinutes * 60_000;
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) listener();
	}

	private subscribe(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private recordProviderFailure(provider: ProviderName, message: string): void {
		const now = Date.now();
		this.providerStates.set(provider, applyProviderRead(this.providerStates.get(provider),
			{ provider, discovery: "failure", error: message },
			{ attemptedAt: now, completedAt: now }, [this.settingsSnapshot.managementKey]));
	}

	private publish(ctx: ExtensionContext): void {
		if (!this.active) return;
		this.renderCurrentModel(ctx);
		this.emitChange();
	}

	private requestRefresh(input: Omit<RefreshRequest, "generation" | "displayRevision">): Promise<void> {
		if (!this.active) return Promise.resolve();
		const request: RefreshRequest = {
			...input,
			generation: this.generation,
			displayRevision: this.displayRevision,
			loaded: input.loaded ? { ...input.loaded, settings: structuredClone(input.loaded.settings) } : undefined,
		};
		this.refreshRequests.add(request);
		this.publish(request.ctx);
		return this.refreshQueue.request(request).finally(() => {
			this.refreshRequests.delete(request);
			if (this.active && request.generation === this.generation) this.publish(request.ctx);
		});
	}

	renderCurrentModel(ctx: ExtensionContext): void {
		if (!this.active) return;
		if (!this.settingsSnapshot.showWidget) {
			ctx.ui.setWidget("cliproxy-usage", undefined);
			this.clearAgeTimer();
			return;
		}
		const snapshot = this.getSnapshot(ctx);
		renderUsage(ctx, snapshot, this.maxVisibleAccounts);
		this.scheduleExpiry(ctx, snapshot);
	}

	private clearProviderCache(provider: ProviderName): void {
		const serverUntil = this.providerStates.get(provider)?.retry?.serverUntil;
		if (serverUntil !== undefined && serverUntil > Date.now()) {
			// Disable removes account data, not an unexpired provider server instruction.
			this.providerStates.set(provider, { provider, accounts: [], retry: { failures: 0, serverUntil } });
		} else this.providerStates.delete(provider);
	}

	private clearAllCaches(): void {
		this.providerStates.clear();
		this.managementRetry = undefined;
		this.clearAgeTimer();
	}

	private notifySettingsWarnings(
		ctx: ExtensionContext,
		loaded: LoadedSettings,
	): void {
		const warning = loaded.writable
			? safeUsageText(loaded.warnings.join("; "), [loaded.settings.managementKey])
			: "Invalid CLIProxyAPI usage settings; correct the configuration file.";
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

	private notifyProviderState(ctx: ExtensionContext, provider: ProviderName): void {
		if (!ctx.hasUI || provider !== this.providerForContext(ctx)) return;
		const snapshot = this.snapshotForProvider(provider);
		ctx.ui.notify(formatSnapshotDetails(snapshot),
			snapshot.stale || snapshot.partial || ["error", "setup-required", "disabled"].includes(snapshot.state) ? "warning" : "info");
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
			const message = safeUsageText(error instanceof Error ? error.message : String(error), [this.settingsSnapshot.managementKey]);
			for (const provider of operation.providers) this.recordProviderFailure(provider, message);
			this.renderCurrentModel(request.ctx);
			this.emitChange();
			if (request.ctx.hasUI) request.ctx.ui.notify(`Failed to refresh CLIProxyAPI usage: ${message}`, "error");
		} finally {
			const current = this.owns(operation);
			if (this.operation === operation) this.operation = undefined;
			if (current) {
				if (request.ctx.hasUI) request.ctx.ui.setStatus("cliproxy-usage", undefined);
				this.publish(request.ctx);
			}
		}
	}

	private async performRefresh(request: RefreshRequest, operation: RefreshOperation): Promise<void> {
		const loaded = request.loaded ?? await loadSettings(this.paths.settingsPath, this.paths.legacySettingsPath);
		if (!this.owns(operation)) return;
		const source = await resolveManagementSource(loaded.settings, this.paths.providerConfigPath);
		if (!this.owns(operation)) return;

		const boundaryChanged = this.sourceBoundary !== undefined && (
			this.sourceBoundary.source.managementUrl !== source.managementUrl ||
			this.sourceBoundary.key !== loaded.settings.managementKey
		);
		// Boundary adoption is distinct from the immutable operation generation.
		// There is only one valid operation; obsolete pending work must not follow it.
		if (boundaryChanged || (this.sourceBoundary && this.settingsInvalidateWork(loaded.settings))) {
			this.refreshQueue.cancelPending();
			this.refreshRequests.clear();
		}
		if (boundaryChanged) {
			this.closeDetails();
			this.clearAllCaches();
			this.rejectedManagementKey = undefined;
		}
		this.sourceBoundary = { source: structuredClone(source), key: loaded.settings.managementKey };
		if (this.timer && loaded.settings.refreshMinutes !== this.settingsSnapshot.refreshMinutes) {
			this.scheduleRefresh(this.refreshContext ?? request.ctx, loaded.settings.refreshMinutes);
		}
		this.settingsKnown = true;
		this.adoptSettings(loaded.settings, request.displayRevision);
		this.maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
		this.notifySettingsWarnings(request.ctx, loaded);
		for (const provider of PROVIDERS) {
			if (!loaded.settings.providers[provider]) this.clearProviderCache(provider);
		}
		operation.providers = request.providers.filter((provider) => loaded.settings.providers[provider]);
		const rejected = this.rejectedManagementKey === loaded.settings.managementKey;
		const configuration = this.configuration();
		const cannotRead = configuration.status === "setup-required" && configuration.reason !== "rejected";
		if (!operation.providers.length || cannotRead || (rejected && !request.force)) {
			this.publish(request.ctx);
			for (const provider of request.notifyProviders) this.notifyProviderState(request.ctx, provider);
			return;
		}

		const attemptedAt = Date.now();
		operation.providers = operation.providers.filter((provider) => isEligible(
			deriveEligibility(this.managementRetry, this.providerStates.get(provider)?.retry, attemptedAt), request.force, attemptedAt));
		if (!operation.providers.length) {
			this.publish(request.ctx);
			for (const provider of request.notifyProviders) this.notifyProviderState(request.ctx, provider);
			return;
		}
		const previousStates = new Map<ProviderName, ProviderUsageState | undefined>();
		for (const provider of operation.providers) {
			previousStates.set(provider, this.providerStates.get(provider));
			this.providerStates.set(provider, beginProviderRead(this.providerStates.get(provider), provider, attemptedAt));
		}
		this.publish(request.ctx);
		if (request.ctx.hasUI) request.ctx.ui.setStatus("cliproxy-usage", request.ctx.ui.theme.fg("dim", "quota refreshing…"));
		const results = await readAccounts(loaded.settings, { source, providers: operation.providers, signal: operation.controller.signal });
		if (!this.owns(operation)) return;
		const completedAt = Date.now();
		const intervalMs = loaded.settings.refreshMinutes * 60_000;
		this.managementRetry = updateRetry(this.managementRetry,
			results.management ?? { attempted: false, failures: [] }, completedAt, intervalMs);
		for (const result of results.providers) {
			// Use pre-begin facts: skipped discovery must roll back the provisional
			// provider attempt while keeping source eligibility visible separately.
			const previous = previousStates.get(result.provider);
			const record = applyProviderRead(previous, result,
				{ attemptedAt, completedAt }, [loaded.settings.managementKey]);
			const actualProviderRead = result.discovery === "success" && result.items.some((item) => item.queried && item.failure?.scope !== "management");
			const complete = result.discovery === "success" && !result.items.some((item) => item.failure?.scope === "management");
			const attempted = actualProviderRead || complete;
			const failures = result.discovery === "success" ? result.items.flatMap((item) =>
				item.queried && item.failure?.scope === "provider" ? [item.failure] : []) : [];
			record.retry = updateRetry(previous?.retry, { attempted, complete, failures }, completedAt, intervalMs);
			this.providerStates.set(result.provider, record);
		}
		this.rejectedManagementKey = results.managementAuthFailed ? loaded.settings.managementKey : undefined;
		this.publish(request.ctx);
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
					`CLIProxyAPI usage refresh failed: ${safeUsageText(error instanceof Error ? error.message : String(error), [this.settingsSnapshot.managementKey])}`,
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
		if (this.timer) this.refreshContext = ctx;
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
					this.detailsViews.delete(view);
					unsubscribe();
					done();
				};
				const view = { provider, close };
				this.detailsViews.add(view);
				const component = new UsageDetailsComponent(tui, theme, {
					getSnapshot: () => !closed && this.active && generation === this.generation &&
						this.providerForContext(ctx) === provider ? this.getSnapshot(ctx) : this.snapshotForProvider(undefined),
					onRefresh: () => {
						if (closed || !this.active || generation !== this.generation) return;
						this.reportBackgroundError(
							ctx,
							this.refreshCurrent(ctx, { force: true }),
						);
					},
					onClose: close,
					onDispose: () => {
						closed = true;
						this.detailsViews.delete(view);
						unsubscribe();
					},
				});
				unsubscribe = this.subscribe(() => {
					if (closed) return;
					if (!this.active || generation !== this.generation || this.providerForContext(ctx) !== provider) {
						close();
						return;
					}
					component.invalidate();
					tui.requestRender();
				});
				queueMicrotask(() => {
					if (
						!closed &&
						this.active && generation === this.generation && this.providerForContext(ctx) === provider &&
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
		this.clearRefreshTimer();
		this.refreshContext = ctx;
		const intervalMs = minutes * 60_000;
		this.nextAutomaticCheckAt = Date.now() + intervalMs;
		this.timer = setInterval(() => {
			if (!this.active || !this.refreshContext) return;
			this.nextAutomaticCheckAt = Date.now() + intervalMs;
			const current = this.refreshContext;
			this.reportBackgroundError(current, this.refreshCurrent(current));
		}, intervalMs);
		this.timer.unref?.();
	}

	private clearRefreshTimer(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.refreshContext = undefined;
		this.nextAutomaticCheckAt = undefined;
	}

	start(ctx: ExtensionContext, loaded: LoadedSettings): void {
		this.invalidateWork(ctx);
		this.clearAllCaches();
		this.sourceBoundary = undefined;
		this.rejectedManagementKey = undefined;
		this.lastSettingsWarning = undefined;
		this.active = true;
		this.settingsKnown = true;
		this.adoptSettings(loaded.settings);
		this.maxVisibleAccounts = loaded.settings.maxVisibleAccounts;
		this.scheduleRefresh(ctx, loaded.settings.refreshMinutes);
		this.reportBackgroundError(ctx, this.refreshCurrent(ctx, { loaded }));
	}

	shutdown(ctx: ExtensionContext): void {
		this.active = false;
		this.invalidateWork();
		this.clearRefreshTimer();
		this.clearAllCaches();
		this.rejectedManagementKey = undefined;
		this.lastSettingsWarning = undefined;
		this.sourceBoundary = undefined;
		this.settingsKnown = false;
		this.changeListeners.clear();
		clearUsage(ctx);
	}

	modelSelected(
		ctx: ExtensionContext,
		provider: ProviderName | undefined,
	): void {
		if (!this.active) return;
		if (this.timer) this.refreshContext = ctx;
		this.closeDetails(provider && this.settingsSnapshot.providers[provider] ? provider : undefined);
		this.publish(ctx);
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
		const sourceChanged = settings.managementUrl !== this.settingsSnapshot.managementUrl ||
			settings.managementKey !== this.settingsSnapshot.managementKey;
		const changedProviders = PROVIDERS.filter((provider) => settings.providers[provider] !== this.settingsSnapshot.providers[provider]);
		const displayOnly = changedId === "showWidget" && !sourceChanged && !changedProviders.length &&
			settings.refreshMinutes === this.settingsSnapshot.refreshMinutes;
		if (displayOnly) {
			this.settingsKnown = true;
			this.adoptSettings(settings);
			this.maxVisibleAccounts = settings.maxVisibleAccounts;
			this.publish(ctx);
			return;
		}
		if (this.settingsInvalidateWork(settings)) this.invalidateWork(ctx);
		this.settingsKnown = true;
		this.adoptSettings(settings);
		this.scheduleRefresh(ctx, settings.refreshMinutes);
		if (changedId === "showWidget" && !sourceChanged) {
			// Combined real provider/interval changes still follow their own boundaries.
			for (const provider of changedProviders) if (!settings.providers[provider]) this.clearProviderCache(provider);
			this.maxVisibleAccounts = settings.maxVisibleAccounts;
			this.publish(ctx);
			const provider = this.providerForContext(ctx);
			if (provider && changedProviders.includes(provider) && settings.providers[provider]) await this.refreshCurrent(ctx);
			return;
		}
		if (changedId === "maxVisibleAccounts") {
			this.maxVisibleAccounts = settings.maxVisibleAccounts;
			this.publish(ctx);
			return;
		}
		if (changedId === "refreshMinutes") { this.publish(ctx); return; }
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
		this.renderCurrentModel(ctx);
		await this.refreshCurrent(ctx, { force: true });
	}

	resetSettings(settings: Settings, ctx?: ExtensionContext): void {
		this.invalidateWork(ctx);
		if (ctx && this.timer) this.refreshContext = ctx;
		else if (!ctx) this.clearRefreshTimer();
		this.settingsKnown = true;
		this.adoptSettings(settings);
		this.clearAllCaches();
		this.sourceBoundary = undefined;
		this.rejectedManagementKey = undefined;
		if (ctx) this.renderCurrentModel(ctx);
		this.emitChange();
	}

	syncSettings(settings: Settings, ctx?: ExtensionContext, observedDisplayRevision?: number): void {
		if (ctx && this.timer) {
			this.refreshContext = ctx;
			if (settings.refreshMinutes !== this.settingsSnapshot.refreshMinutes) this.scheduleRefresh(ctx, settings.refreshMinutes);
		}
		const sourceChanged = settings.managementUrl !== this.settingsSnapshot.managementUrl ||
			settings.managementKey !== this.settingsSnapshot.managementKey;
		if (this.settingsInvalidateWork(settings)) this.invalidateWork(ctx);
		if (sourceChanged) {
			this.clearAllCaches();
			this.sourceBoundary = undefined;
			this.rejectedManagementKey = undefined;
		}
		for (const provider of PROVIDERS) if (!settings.providers[provider]) this.clearProviderCache(provider);
		this.settingsKnown = true;
		this.adoptSettings(settings, observedDisplayRevision);
		this.maxVisibleAccounts = settings.maxVisibleAccounts;
		if (ctx) this.renderCurrentModel(ctx);
		this.emitChange();
	}

	private displayUrl(value?: string): string {
		if (!value) return "not found";
		try {
			const url = new URL(value);
			url.username = "";
			url.password = "";
			return safeUsageText(url.toString(), [this.settingsSnapshot.managementKey]);
		} catch { return "invalid URL"; }
	}

	async showStatus(ctx: ExtensionContext): Promise<void> {
		if (!this.active) return;
		const generation = this.generation;
		const displayRevision = this.displayRevision;
		try {
			const loaded = await loadSettings(this.paths.settingsPath, this.paths.legacySettingsPath);
			if (!this.active || generation !== this.generation) return;
			const source = await resolveManagementSource(loaded.settings, this.paths.providerConfigPath);
			if (!this.active || generation !== this.generation) return;
			this.syncSettings(loaded.settings, ctx, displayRevision);
			if (this.sourceBoundary && (this.sourceBoundary.source.managementUrl !== source.managementUrl ||
				this.sourceBoundary.key !== loaded.settings.managementKey)) {
				this.invalidateWork(ctx);
				this.clearAllCaches();
				this.rejectedManagementKey = undefined;
			}
			this.sourceBoundary = { source: structuredClone(source), key: loaded.settings.managementKey };
			this.notifySettingsWarnings(ctx, loaded);
			this.publish(ctx);
			const snapshot = this.getSnapshot(ctx);
			const providers = PROVIDERS.filter((provider) => loaded.settings.providers[provider]).map((provider) => PROVIDER_LABELS[provider]);
			if (ctx.hasUI) ctx.ui.notify([
				`Settings: ${loaded.path}`,
				`Provider config: ${this.paths.providerConfigPath}`,
				`Provider base URL: ${this.displayUrl(source.providerBaseUrl)}`,
				`Management URL: ${this.displayUrl(source.managementUrl)}`,
				`Management key: ${loaded.settings.managementKey ? "configured" : "missing"}`,
				`Current model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected"}`,
				`Current usage provider: ${snapshot.provider ? PROVIDER_LABELS[snapshot.provider] : "unsupported"}`,
				`Refresh: ${loaded.settings.refreshMinutes} min`,
				`Visible accounts: ${loaded.settings.maxVisibleAccounts}`,
				`Widget: ${this.settingsSnapshot.showWidget ? "shown" : "hidden"}`,
				`Providers: ${providers.join(", ") || "none"}`,
				formatSnapshotDetails(snapshot),
			].join("\n"), snapshot.state === "setup-required" || snapshot.state === "error" || snapshot.partial || snapshot.stale || !loaded.writable ? "warning" : "info");
		} catch (error) {
			if (this.active && generation === this.generation && ctx.hasUI) {
				ctx.ui.notify(`Failed to read usage status: ${safeUsageText(error instanceof Error ? error.message : String(error), [this.settingsSnapshot.managementKey])}`, "error");
			}
		}
	}

	lastRefresh(provider: ProviderName | undefined): Date | undefined {
		const at = provider ? this.providerStates.get(provider)?.lastCompleteSuccessAt : undefined;
		return at === undefined ? undefined : new Date(at);
	}
}
