import { z } from "zod";
import { JUDGE_MODEL_HAIKU, JUDGE_MODEL_OPUS, JUDGE_MODEL_SONNET } from "../evolution/judge-models.ts";
import type { PhantomConfig } from "./types.ts";

// Provider config lives here as a single deterministic map from a user-facing YAML
// block into a flat set of environment variables consumed by the Agent SDK subprocess.
// The Agent SDK already understands every knob we need (ANTHROPIC_BASE_URL,
// ANTHROPIC_AUTH_TOKEN, ANTHROPIC_DEFAULT_*_MODEL, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
// API_TIMEOUT_MS). Phantom's job is to expose those knobs through YAML. Nothing more.
//
// Phase C metadata path: when the top-level `secret_source: "metadata"` is set,
// the loader fetches the secret named by `provider.secret_name` from the host
// metadata gateway and pre-populates the selected provider key before these
// helpers run. Cloud tenants and self-host installs share the same code path.

export const PROVIDER_TYPES = [
	"anthropic",
	"openai",
	"zai",
	"openrouter",
	"vllm",
	"ollama",
	"litellm",
	"custom",
] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const ProviderSchema = z
	.object({
		type: z.enum(PROVIDER_TYPES).default("anthropic"),
		base_url: z.string().url().optional(),
		api_key_env: z.string().min(1).optional(),
		// Phase C: when the top-level `secret_source: "metadata"` is set, the
		// loader passes this name to the metadata gateway and injects the
		// resolved plaintext into the selected provider key before env builders
		// run. Default "provider_token" so a Cloud tenant who flips
		// secret_source to metadata gets the right behavior. The regex
		// matches the metadata fetcher's defense-in-depth check; pinning it at
		// the schema level surfaces invalid names at parse time rather than
		// crashing at boot inside the fetcher.
		secret_name: z
			.string()
			.regex(/^[a-z_][a-z0-9_]*$/, {
				message:
					"secret_name must match /^[a-z_][a-z0-9_]*$/ (lowercase letters, digits, underscores; cannot start with a digit)",
			})
			.default("provider_token"),
		model_mappings: z
			.object({
				opus: z.string().min(1).optional(),
				sonnet: z.string().min(1).optional(),
				haiku: z.string().min(1).optional(),
			})
			.optional(),
		disable_betas: z.boolean().optional(),
		timeout_ms: z.number().int().positive().optional(),
	})
	.default({ type: "anthropic" });

export type ProviderConfig = z.infer<typeof ProviderSchema>;

type ProviderPreset = {
	base_url: string | undefined;
	api_key_env: string | undefined;
	disable_betas: boolean;
};

// Preset defaults. User overrides in phantom.yaml win over these. `anthropic` is the
// only preset that leaves `base_url` undefined (so the Agent SDK uses its built-in
// default) and the only preset that does not disable experimental betas. Every third
// party proxy rejects unknown beta headers, so we turn them off by default for those.
export const PROVIDER_PRESETS: Readonly<Record<ProviderType, ProviderPreset>> = Object.freeze({
	anthropic: {
		base_url: undefined,
		api_key_env: "ANTHROPIC_API_KEY",
		disable_betas: false,
	},
	openai: {
		base_url: undefined,
		api_key_env: "OPENAI_API_KEY",
		disable_betas: false,
	},
	zai: {
		base_url: "https://api.z.ai/api/anthropic",
		api_key_env: "ZAI_API_KEY",
		disable_betas: true,
	},
	openrouter: {
		base_url: "https://openrouter.ai/api/v1",
		api_key_env: "OPENROUTER_API_KEY",
		disable_betas: true,
	},
	vllm: {
		base_url: "http://localhost:8000",
		api_key_env: undefined,
		disable_betas: true,
	},
	ollama: {
		base_url: "http://localhost:11434",
		api_key_env: undefined,
		disable_betas: true,
	},
	litellm: {
		base_url: "http://localhost:4000",
		api_key_env: "LITELLM_KEY",
		disable_betas: true,
	},
	custom: {
		base_url: undefined,
		api_key_env: undefined,
		disable_betas: true,
	},
});

export type ModelTier = "opus" | "sonnet" | "haiku";

const MURPH_ROUTE_ENV_KEYS = [
	"MURPH_PROVIDER",
	"MURPH_PROVIDER_CONFIG",
	"MURPH_MODEL",
	"MURPH_OPENAI_MODEL",
	"MURPH_GLM_MODEL",
	"MURPH_ANTHROPIC_MODEL",
	"MURPH_QWEN_MODEL",
	"MURPH_CUSTOM_MODEL",
	"OPENAI_BASE_URL",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS",
] as const;

const MURPH_CREDENTIAL_ENV_KEYS = [
	"OPENAI_API_KEY",
	"ZAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"DASHSCOPE_API_KEY",
	"XAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"OPENROUTER_API_KEY",
	"TOGETHER_API_KEY",
	"FIREWORKS_API_KEY",
	"CEREBRAS_API_KEY",
	"GROQ_API_KEY",
	"LITELLM_KEY",
] as const;

const JUDGE_MODEL_TIERS: Readonly<Record<string, ModelTier>> = Object.freeze({
	[JUDGE_MODEL_OPUS]: "opus",
	[JUDGE_MODEL_SONNET]: "sonnet",
	[JUDGE_MODEL_HAIKU]: "haiku",
});

function tierForRequestedModel(requestedModel: string): ModelTier | undefined {
	if (requestedModel === "opus" || requestedModel === "sonnet" || requestedModel === "haiku") {
		return requestedModel;
	}
	return JUDGE_MODEL_TIERS[requestedModel];
}

function addSelectedCredential(
	env: Record<string, string>,
	sourceEnvKey: string | undefined,
	targetEnvKey: string | undefined,
): void {
	if (!sourceEnvKey || !targetEnvKey) return;
	const resolved = process.env[sourceEnvKey];
	if (resolved && resolved.length > 0) {
		env[targetEnvKey] = resolved;
	}
	if (sourceEnvKey !== targetEnvKey) {
		env[sourceEnvKey] = "";
	}
}

function blankMurphRouteEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of MURPH_ROUTE_ENV_KEYS) {
		env[key] = "";
	}
	for (const key of MURPH_CREDENTIAL_ENV_KEYS) {
		env[key] = "";
	}
	return env;
}

export function selectedProviderSecretEnvKey(config: PhantomConfig): string | undefined {
	return config.provider.api_key_env ?? PROVIDER_PRESETS[config.provider.type].api_key_env;
}

export function resolveAgentRuntimeModel(config: PhantomConfig, requestedModel: string, tier?: ModelTier): string {
	if (config.agent_runtime !== "murph") {
		return requestedModel;
	}
	const mappedTier = tier ?? tierForRequestedModel(requestedModel);
	if (!mappedTier) {
		return requestedModel;
	}
	return config.provider.model_mappings?.[mappedTier] ?? requestedModel;
}

export function buildMurphProviderEnv(
	config: PhantomConfig,
	requestedModel: string,
	tier?: ModelTier,
): Record<string, string> {
	const provider = config.provider;
	const resolvedModel = resolveAgentRuntimeModel(config, requestedModel, tier);
	const sourceEnvKey = selectedProviderSecretEnvKey(config);
	const env = blankMurphRouteEnv();

	env.MURPH_MODEL = resolvedModel;

	switch (provider.type) {
		case "anthropic": {
			env.MURPH_PROVIDER = "anthropic";
			env.MURPH_ANTHROPIC_MODEL = resolvedModel;
			addSelectedCredential(env, sourceEnvKey, "ANTHROPIC_API_KEY");
			break;
		}
		case "openai": {
			env.MURPH_PROVIDER = "openai";
			env.MURPH_OPENAI_MODEL = resolvedModel;
			if (provider.base_url) {
				env.OPENAI_BASE_URL = provider.base_url;
			}
			addSelectedCredential(env, sourceEnvKey, "OPENAI_API_KEY");
			break;
		}
		case "zai": {
			env.MURPH_PROVIDER = "glm";
			env.MURPH_GLM_MODEL = resolvedModel;
			if (provider.base_url) {
				env.OPENAI_BASE_URL = provider.base_url;
			}
			addSelectedCredential(env, sourceEnvKey, "ZAI_API_KEY");
			break;
		}
		case "openrouter": {
			env.MURPH_PROVIDER = "openai-compat";
			env.MURPH_PROVIDER_CONFIG = "openrouter";
			if (provider.base_url) {
				env.OPENAI_BASE_URL = provider.base_url;
			}
			addSelectedCredential(env, sourceEnvKey, "OPENROUTER_API_KEY");
			break;
		}
		case "ollama":
		case "vllm": {
			env.MURPH_PROVIDER = "openai-compat";
			env.MURPH_PROVIDER_CONFIG = provider.type;
			if (provider.base_url) {
				env.OPENAI_BASE_URL = provider.base_url;
			}
			break;
		}
		case "litellm": {
			env.MURPH_PROVIDER = "openai-compat";
			env.MURPH_PROVIDER_CONFIG = "litellm";
			if (provider.base_url) {
				env.OPENAI_BASE_URL = provider.base_url;
			}
			addSelectedCredential(env, sourceEnvKey, "LITELLM_KEY");
			break;
		}
		case "custom": {
			env.MURPH_PROVIDER = "openai-compat";
			env.MURPH_PROVIDER_CONFIG = "custom";
			if (provider.base_url) {
				env.OPENAI_BASE_URL = provider.base_url;
			}
			addSelectedCredential(env, sourceEnvKey, "OPENAI_API_KEY");
			break;
		}
	}

	return env;
}

export function buildAgentRuntimeEnv(
	config: PhantomConfig,
	requestedModel: string,
	tier?: ModelTier,
): Record<string, string> {
	if (config.agent_runtime === "murph") {
		return buildMurphProviderEnv(config, requestedModel, tier);
	}
	return buildProviderEnv(config);
}

/**
 * Pure function: translate a PhantomConfig.provider block into a flat map of env var
 * overrides suitable for merging into the Agent SDK subprocess environment.
 *
 * Contract:
 *  - Never returns undefined values. Only keys that should be set appear in the map.
 *  - Returns a fresh object every call. No caching, no shared state.
 *  - Reads process.env only to resolve the configured api_key_env variable.
 *  - Does not throw on missing credentials. If the api_key_env variable is unset,
 *    the subprocess will fail at call time with a clearer error than we could raise
 *    here, and local providers like Ollama legitimately do not need a key at all.
 */
export function buildProviderEnv(config: PhantomConfig): Record<string, string> {
	const provider = config.provider;
	if (provider.type === "openai") {
		throw new Error('provider.type "openai" requires agent_runtime: murph.');
	}
	const preset = PROVIDER_PRESETS[provider.type];
	const env: Record<string, string> = {};

	// Resolve effective values: explicit user config wins over preset defaults.
	const baseUrl = provider.base_url ?? preset.base_url;
	const apiKeyEnv = provider.api_key_env ?? preset.api_key_env;
	const disableBetas = provider.disable_betas ?? preset.disable_betas;

	// Why: ANTHROPIC_BASE_URL is the single knob the bundled cli.js respects for
	// redirecting every Messages API call to a different host. Setting it routes
	// the subprocess at the chosen provider.
	if (baseUrl) {
		env.ANTHROPIC_BASE_URL = baseUrl;
	}

	// Why: the bundled cli.js's auth factory (_y()) prefers ANTHROPIC_API_KEY over
	// ANTHROPIC_AUTH_TOKEN. Setting both to the same resolved value is deliberately
	// redundant. It avoids the "wrong header, wrong auth" failure mode where a
	// third-party proxy accepts one header format but not the other.
	if (apiKeyEnv) {
		const resolved = process.env[apiKeyEnv];
		if (resolved && resolved.length > 0) {
			env.ANTHROPIC_AUTH_TOKEN = resolved;
			env.ANTHROPIC_API_KEY = resolved;
		}
	}

	// Why: the bundled cli.js reads these three vars to resolve the opus/sonnet/haiku
	// aliases to concrete model IDs on the chosen provider. A Z.AI user who sets
	// `model: opus` in phantom.yaml gets GLM-5.1 on the wire if opus is mapped here.
	const mappings = provider.model_mappings;
	if (mappings?.opus) {
		env.ANTHROPIC_DEFAULT_OPUS_MODEL = mappings.opus;
	}
	if (mappings?.sonnet) {
		env.ANTHROPIC_DEFAULT_SONNET_MODEL = mappings.sonnet;
	}
	if (mappings?.haiku) {
		env.ANTHROPIC_DEFAULT_HAIKU_MODEL = mappings.haiku;
	}

	// Why: CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 stops the bundled cli.js from
	// sending the `anthropic-beta: ...` header. Third-party proxies reject unknown
	// beta values, so we default this on for every non-anthropic preset. Operators
	// can still override by setting disable_betas: false in YAML.
	if (disableBetas) {
		env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
	}

	// Why: API_TIMEOUT_MS is the bundled cli.js's per-request HTTP timeout. Local
	// models on Ollama / vLLM can be slow on first call, so we expose a knob.
	if (typeof provider.timeout_ms === "number") {
		env.API_TIMEOUT_MS = String(provider.timeout_ms);
	}

	return env;
}
