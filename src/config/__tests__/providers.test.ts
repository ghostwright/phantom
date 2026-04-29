import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROVIDER_PRESETS, ProviderSchema, buildProviderEnv } from "../providers.ts";
import { PhantomConfigSchema } from "../schemas.ts";
import type { PhantomConfig } from "../types.ts";

// Helper: build a minimal valid PhantomConfig with an overrideable provider block.
// Going through PhantomConfigSchema.parse() is deliberate: it exercises the real
// default pipeline, so any drift between schemas.ts and providers.ts shows up here.
function makeConfig(providerOverride?: unknown): PhantomConfig {
	const raw: Record<string, unknown> = { name: "test-phantom" };
	if (providerOverride !== undefined) {
		raw.provider = providerOverride;
	}
	return PhantomConfigSchema.parse(raw);
}

// Env var sandbox: snapshot the process.env keys we touch and restore them after
// each test so buildProviderEnv's reads of process.env don't bleed between tests
// or pollute other files in the same bun test run.
const WATCHED = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ZAI_API_KEY",
	"OPENROUTER_API_KEY",
	"LITELLM_KEY",
] as const;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of WATCHED) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	for (const key of WATCHED) {
		if (saved[key] !== undefined) {
			process.env[key] = saved[key];
		} else {
			delete process.env[key];
		}
	}
});

describe("ProviderSchema", () => {
	test("defaults to anthropic when block is absent", () => {
		const config = PhantomConfigSchema.parse({ name: "x" });
		expect(config.provider.type).toBe("anthropic");
		expect(config.provider.base_url).toBeUndefined();
		expect(config.provider.api_key_env).toBeUndefined();
	});

	test("accepts each valid provider type", () => {
		for (const type of ["anthropic", "zai", "openrouter", "vllm", "ollama", "litellm", "custom"] as const) {
			const parsed = ProviderSchema.parse({ type });
			expect(parsed.type).toBe(type);
		}
	});

	test("rejects an unknown provider type", () => {
		const result = ProviderSchema.safeParse({ type: "nope" });
		expect(result.success).toBe(false);
	});

	test("accepts a valid base_url", () => {
		const parsed = ProviderSchema.parse({ type: "custom", base_url: "https://llm.example.com/v1" });
		expect(parsed.base_url).toBe("https://llm.example.com/v1");
	});

	test("rejects a malformed base_url", () => {
		const result = ProviderSchema.safeParse({ type: "custom", base_url: "not a url" });
		expect(result.success).toBe(false);
	});

	test("accepts model_mappings with any subset of the three aliases", () => {
		const parsed = ProviderSchema.parse({ type: "zai", model_mappings: { opus: "glm-5.1" } });
		expect(parsed.model_mappings?.opus).toBe("glm-5.1");
		expect(parsed.model_mappings?.sonnet).toBeUndefined();
	});

	test("rejects an empty string in api_key_env", () => {
		const result = ProviderSchema.safeParse({ type: "zai", api_key_env: "" });
		expect(result.success).toBe(false);
	});

	test("rejects a zero timeout_ms", () => {
		const result = ProviderSchema.safeParse({ type: "zai", timeout_ms: 0 });
		expect(result.success).toBe(false);
	});
});

describe("buildProviderEnv: anthropic default", () => {
	test("returns an empty map when no credentials are present", () => {
		const config = makeConfig();
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
	});

	test("picks up ANTHROPIC_API_KEY from the environment", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const env = buildProviderEnv(makeConfig());
		expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-test");
		expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
	});

	test("does not disable betas for the anthropic provider", () => {
		process.env.ANTHROPIC_API_KEY = "sk-ant-test";
		const env = buildProviderEnv(makeConfig());
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
	});
});

describe("buildProviderEnv: zai preset", () => {
	test("sets base_url, auth token, api key, and disables betas", () => {
		process.env.ZAI_API_KEY = "zai-secret";
		const config = makeConfig({ type: "zai" });
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("zai-secret");
		expect(env.ANTHROPIC_API_KEY).toBe("zai-secret");
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
	});

	test("honors an explicit api_key_env override", () => {
		process.env.OPENROUTER_API_KEY = "the-other-key";
		const config = makeConfig({ type: "zai", api_key_env: "OPENROUTER_API_KEY" });
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("the-other-key");
		expect(env.ANTHROPIC_API_KEY).toBe("the-other-key");
	});

	test("model_mappings propagate to ANTHROPIC_DEFAULT_*_MODEL", () => {
		process.env.ZAI_API_KEY = "zai-secret";
		const config = makeConfig({
			type: "zai",
			model_mappings: { opus: "glm-5.1", sonnet: "glm-5.1", haiku: "glm-4.5-air" },
		});
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("glm-5.1");
		expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("glm-5.1");
		expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("glm-4.5-air");
	});

	test("missing ZAI_API_KEY leaves auth fields unset but still sets base_url", () => {
		const config = makeConfig({ type: "zai" });
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
	});
});

describe("buildProviderEnv: ollama preset", () => {
	test("sets local base_url, no auth token, disables betas", () => {
		const config = makeConfig({ type: "ollama" });
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_BASE_URL).toBe("http://localhost:11434");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
	});
});

describe("buildProviderEnv: custom preset", () => {
	test("respects explicit base_url and api_key_env", () => {
		process.env.LITELLM_KEY = "custom-secret";
		const config = makeConfig({
			type: "custom",
			base_url: "https://my-proxy.internal/anthropic",
			api_key_env: "LITELLM_KEY",
		});
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_BASE_URL).toBe("https://my-proxy.internal/anthropic");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("custom-secret");
		expect(env.ANTHROPIC_API_KEY).toBe("custom-secret");
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
	});
});

describe("buildProviderEnv: user override wins over preset", () => {
	test("user base_url beats the zai default", () => {
		process.env.ZAI_API_KEY = "zai-secret";
		const config = makeConfig({ type: "zai", base_url: "https://staging.z.ai/api/anthropic" });
		const env = buildProviderEnv(config);
		expect(env.ANTHROPIC_BASE_URL).toBe("https://staging.z.ai/api/anthropic");
	});

	test("explicit disable_betas: false overrides the preset's true", () => {
		process.env.ZAI_API_KEY = "zai-secret";
		const config = makeConfig({ type: "zai", disable_betas: false });
		const env = buildProviderEnv(config);
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBeUndefined();
	});

	test("explicit disable_betas: true on anthropic overrides the preset's false", () => {
		const config = makeConfig({ type: "anthropic", disable_betas: true });
		const env = buildProviderEnv(config);
		expect(env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS).toBe("1");
	});
});

describe("buildProviderEnv: timeout_ms and invariants", () => {
	test("timeout_ms propagates to API_TIMEOUT_MS as a string", () => {
		const config = makeConfig({ type: "ollama", timeout_ms: 60_000 });
		const env = buildProviderEnv(config);
		expect(env.API_TIMEOUT_MS).toBe("60000");
	});

	test("returned map never contains undefined values", () => {
		process.env.ZAI_API_KEY = "zai-secret";
		const config = makeConfig({ type: "zai", model_mappings: { opus: "glm-5.1" } });
		const env = buildProviderEnv(config);
		for (const [key, value] of Object.entries(env)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
			expect(key).not.toBe("");
		}
	});

	test("is pure: two calls with the same input return equivalent independent maps", () => {
		process.env.ZAI_API_KEY = "zai-secret";
		const config = makeConfig({ type: "zai" });
		const first = buildProviderEnv(config);
		const second = buildProviderEnv(config);
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
		first.ANTHROPIC_BASE_URL = "mutated";
		expect(second.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
	});
});

describe("PROVIDER_PRESETS", () => {
	test("contains every provider type declared in the schema", () => {
		for (const type of ["anthropic", "zai", "openrouter", "vllm", "ollama", "litellm", "custom"] as const) {
			expect(PROVIDER_PRESETS[type]).toBeDefined();
		}
	});

	test("anthropic preset has no base_url and leaves betas enabled", () => {
		expect(PROVIDER_PRESETS.anthropic.base_url).toBeUndefined();
		expect(PROVIDER_PRESETS.anthropic.disable_betas).toBe(false);
	});

	test("every non-anthropic preset disables betas by default", () => {
		for (const type of ["zai", "openrouter", "vllm", "ollama", "litellm", "custom"] as const) {
			expect(PROVIDER_PRESETS[type].disable_betas).toBe(true);
		}
	});
});
