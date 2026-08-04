export type ProviderName = "claude" | "codex" | "grok" | "kimi";

export type Settings = {
	accountsDir: string;
	refreshMinutes: number;
	maxVisibleAccounts: number;
	providers: Record<ProviderName, boolean>;
};

export type Config = Settings;

export type UsageWindow = {
	/** Short window name shown in the widget, e.g. "5h", "7d", "Plan". */
	label: string;
	/** Percentage consumed, 0-100. */
	used: number;
	resetsAt?: Date;
};

export type AccountUsage = {
	provider: ProviderName;
	label: string;
	windows: UsageWindow[];
	error?: string;
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
