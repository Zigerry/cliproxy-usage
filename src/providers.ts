import type { ProviderName } from "./types.js";

export const PROVIDERS = [
	"claude",
	"codex",
	"deepseek",
	"grok",
	"kimi",
] as const satisfies readonly ProviderName[];

export const PROVIDER_LABELS: Record<ProviderName, string> = {
	claude: "Claude",
	codex: "Codex",
	deepseek: "DeepSeek",
	grok: "Grok",
	kimi: "Kimi",
};
