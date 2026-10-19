export type ProviderName =
	| "claude"
	| "codex"
	| "deepseek"
	| "grok"
	| "kimi";

export type Settings = {
	/** Optional CLIProxyAPI root used instead of the provider's configured base URL. */
	managementUrl: string;
	/** Plaintext Management API key, stored only in the mode-0600 settings file. */
	managementKey: string;
	refreshMinutes: number;
	maxVisibleAccounts: number;
	providers: Record<ProviderName, boolean>;
};

export type UsageWindow = {
	/** Short window name shown in the widget, e.g. "5h", "7d", "Plan". */
	label: string;
	/** Percentage consumed, 0-100. */
	used: number;
	resetsAt?: Date;
};

export type BalanceAmount = {
	currency: string;
	amount: number;
};

export type AccountBalance = {
	available: boolean;
	amounts: BalanceAmount[];
};

export type AccountUsage = {
	provider: ProviderName;
	/** Opaque Management auth_index; never a display label or credential. */
	accountId?: string;
	/** Read-layer fact: false for unavailable/missing-ID/auth-skipped entries. */
	queried?: boolean;
	label: string;
	windows: UsageWindow[];
	balance?: AccountBalance;
	error?: string;
};

export type ProviderReadResult =
	| { provider: ProviderName; discovery: "success"; items: AccountUsage[] }
	| { provider: ProviderName; discovery: "failure"; error: string };

export type ReadAccountsResult = {
	providers: ProviderReadResult[];
	managementAuthFailed: boolean;
};

export type UsageData = {
	windows: UsageWindow[];
	balance?: AccountBalance;
};

export type AccountUsageState = {
	provider: ProviderName;
	accountId?: string;
	label: string;
	queried: boolean;
	attemptedAt?: number;
	result: "valid" | "unknown" | "error";
	error?: string;
	valid?: { at: number; data: UsageData };
};

export type ProviderUsageState = {
	provider: ProviderName;
	accounts: AccountUsageState[];
	lastAttemptAt?: number;
	discovery?: { result: "success" | "error"; at: number; error?: string };
	lastCompleteSuccessAt?: number;
};

export type UsageConfiguration =
	| { status: "pending" }
	| { status: "ready" }
	| { status: "setup-required"; reason: "missing-key" | "missing-url" | "invalid-source" | "rejected"; message?: string };

export type ReadonlyAccountBalance = {
	readonly available: boolean;
	readonly amounts: readonly Readonly<BalanceAmount>[];
};

export type AccountUsageSnapshot = {
	readonly provider: ProviderName;
	readonly accountId?: string;
	readonly label: string;
	readonly windows: readonly Readonly<UsageWindow>[];
	readonly balance?: ReadonlyAccountBalance;
	readonly queried: boolean;
	readonly attemptedAt?: number;
	readonly lastValidAt?: number;
	readonly result: "valid" | "unknown" | "error";
	readonly error?: string;
	readonly cached: boolean;
	readonly stale: boolean;
};

export type UsageSnapshot = {
	readonly provider?: ProviderName;
	readonly state: "unsupported" | "disabled" | "setup-required" | "idle" | "loading" | "ready" | "empty" | "unknown" | "error";
	readonly configuration: Readonly<UsageConfiguration>;
	readonly refreshing: boolean;
	readonly stale: boolean;
	readonly partial: boolean;
	readonly accounts: readonly AccountUsageSnapshot[];
	readonly lastAttemptAt?: number;
	readonly lastCompleteSuccessAt?: number;
	readonly error?: string;
	readonly generatedAt: number;
};

export type Theme = {
	fg(color: string, text: string): string;
};

export type UiContext = {
	mode: string;
	ui: {
		theme: Theme;
		setStatus(id: string, text: string | undefined): void;
		setWidget(
			id: string,
			content: unknown,
			options?: { placement: "belowEditor" },
		): void;
		notify(message: string, level: "info" | "warning" | "error"): void;
		select(title: string, options: string[]): Promise<string | undefined>;
		input(title: string, placeholder?: string): Promise<string | undefined>;
	};
};
