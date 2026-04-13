import { z } from "zod";
import type { PhantomConfig } from "./types.ts";

// Provider config lives here as a single deterministic map from a user-facing YAML
// block into a flat set of environment variables consumed by the Agent SDK subprocess.
// The Agent SDK already understands every knob we need (ANTHROPIC_BASE_URL,
// ANTHROPIC_AUTH_TOKEN, ANTHROPIC_DEFAULT_*_MODEL, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS,
// API_TIMEOUT_MS). Phantom's job is to expose those knobs through YAML. Nothing more.

export const PROVIDER_TYPES = ["anthropic", "zai", "openrouter", "vllm", "ollama", "litellm", "custom"] as const;

export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const ProviderSchema = z
	.object({
		type: z.enum(PROVIDER_TYPES).default("anthropic"),
		base_url: z.string().url().optional(),
		api_key_env: z.string().min(1).optional(),
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
