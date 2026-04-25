// Phantom config loader.
//
// Two entry points: `loadConfigSync` (the historical sync function, kept under
// a new name so it remains usable from contexts that legitimately cannot await)
// and `loadConfig` (a thin async wrapper that adds the Phase C metadata-secret
// resolution path on top). For the default `secret_source: "env"` the wrapper
// is sync-fast: it parses, validates, returns. The async machinery only runs
// when an operator opts in via `secret_source: metadata` in phantom.yaml.
//
// When `secret_source === "metadata"` the loader fetches the provider token
// from the host metadata gateway and writes it into `process.env` BEFORE
// returning. This is deliberate: `buildProviderEnv` (in providers.ts) reads
// `process.env.<api_key_env>` to populate the Agent SDK subprocess env, and
// keeping that contract means the metadata path is a transparent prefix to
// the existing flow with zero downstream plumbing changes.
//
// Security invariant on `${secret:NAME}` interpolation: the regex requires
// the ENTIRE string value to be `${secret:NAME}`. Partial substring matches
// like `https://hook/?token=${secret:provider_token}` are intentionally NOT
// resolved. If we matched substrings, an operator could embed a secret into
// any URL or log message, and downstream code that logs URLs would leak the
// plaintext. By requiring whole-string matches, the resolved replacement IS
// the plaintext itself, never a string containing the plaintext, so the
// surface for accidental disclosure is the existing `process.env` surface.
//
// Note on type safety: the walker treats the config as a generic
// Record<string, unknown> so it can recurse over arbitrary nested objects.
// The single `as unknown as Record<string, unknown>` cast at the entry point
// (where loadConfig hands the typed PhantomConfig to interpolateSecretsInPlace)
// is the only place we cross the typed/generic boundary; the walker itself
// does not introduce further casts beyond a recursive descent step.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { MetadataSecretFetcher } from "./metadata-fetcher.ts";
import { PROVIDER_TYPES, type ProviderType } from "./providers.ts";
import { type ChannelsConfig, ChannelsConfigSchema, PhantomConfigSchema } from "./schemas.ts";
import type { PhantomConfig } from "./types.ts";

const DEFAULT_CONFIG_PATH = "config/phantom.yaml";
const DEFAULT_CHANNELS_PATH = "config/channels.yaml";
const DEFAULT_METADATA_BASE_URL = "http://169.254.169.254";
const SECRET_REF_REGEX = /^\$\{secret:([a-z_][a-z0-9_]*)\}$/;

/**
 * Synchronous loader. Reads the YAML, validates against the schema, applies
 * env-var overrides, and returns the parsed config. Use this from contexts
 * that genuinely cannot await; metadata-mode resolution is unavailable here.
 *
 * The default `secret_source: "env"` path is byte-identical to the loader
 * that shipped before Phase C: an operator who never sets `secret_source`
 * sees no behaviour change.
 */
export function loadConfigSync(path?: string): PhantomConfig {
	const configPath = path ?? DEFAULT_CONFIG_PATH;

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch {
		throw new Error(`Config file not found: ${configPath}. Create it or copy from config/phantom.yaml.example`);
	}

	const parsed: unknown = parse(text);

	const result = PhantomConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		throw new Error(`Invalid config at ${configPath}:\n${issues}`);
	}

	const config = result.data;

	// Environment variable overrides for runtime flexibility.
	// These let operators change settings via env without editing YAML.
	if (process.env.PHANTOM_MODEL) {
		config.model = process.env.PHANTOM_MODEL;
	}
	if (process.env.PHANTOM_DOMAIN) {
		config.domain = process.env.PHANTOM_DOMAIN;
	}
	if (process.env.PHANTOM_NAME?.trim()) {
		config.name = process.env.PHANTOM_NAME.trim();
	}
	if (process.env.PHANTOM_ROLE?.trim()) {
		config.role = process.env.PHANTOM_ROLE.trim();
	}
	if (process.env.PHANTOM_EFFORT) {
		const effort = process.env.PHANTOM_EFFORT;
		if (effort === "low" || effort === "medium" || effort === "high" || effort === "max") {
			config.effort = effort;
		}
	}
	if (process.env.PORT) {
		const port = Number.parseInt(process.env.PORT, 10);
		if (port > 0 && port <= 65535) {
			config.port = port;
		}
	}
	// Provider env overrides: let operators flip backends without editing YAML.
	// Only the two highest-leverage fields are exposed here. Anything more granular
	// (model mappings, timeouts, beta flags) belongs in the YAML block.
	if (process.env.PHANTOM_PROVIDER_TYPE?.trim()) {
		const candidate = process.env.PHANTOM_PROVIDER_TYPE.trim();
		if ((PROVIDER_TYPES as readonly string[]).includes(candidate)) {
			config.provider.type = candidate as ProviderType;
		} else {
			console.warn(`[config] PHANTOM_PROVIDER_TYPE is not a known provider: ${candidate}`);
		}
	}
	if (process.env.PHANTOM_PROVIDER_BASE_URL?.trim()) {
		const candidate = process.env.PHANTOM_PROVIDER_BASE_URL.trim();
		try {
			new URL(candidate);
			config.provider.base_url = candidate;
		} catch {
			console.warn(`[config] PHANTOM_PROVIDER_BASE_URL is not a valid URL: ${candidate}`);
		}
	}

	if (process.env.PHANTOM_PUBLIC_URL?.trim()) {
		const candidate = process.env.PHANTOM_PUBLIC_URL.trim();
		try {
			new URL(candidate);
			config.public_url = candidate;
		} catch {
			console.warn(`[config] PHANTOM_PUBLIC_URL is not a valid URL: ${candidate}`);
		}
	}

	// Derive public_url from name + domain when not explicitly set
	if (!config.public_url && config.domain) {
		const derived = `https://${config.name}.${config.domain}`;
		try {
			new URL(derived);
			config.public_url = derived;
		} catch {
			// Name or domain produced an invalid URL, skip derivation
		}
	}

	return config;
}

/**
 * Async loader. Calls `loadConfigSync` and, when `secret_source === "metadata"`,
 * resolves the provider token from the host metadata gateway, populates
 * `process.env.ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (so the unchanged
 * `buildProviderEnv` finds it), and walks the parsed config replacing any
 * `${secret:NAME}` references with their resolved plaintext.
 *
 * For `secret_source === "env"` (the default) this is a sync-fast path that
 * just returns the parsed config.
 */
export async function loadConfig(path?: string): Promise<PhantomConfig> {
	const config = loadConfigSync(path);

	if (config.secret_source !== "metadata") {
		return config;
	}

	const baseUrl = config.secret_source_url ?? DEFAULT_METADATA_BASE_URL;
	const fetcher = new MetadataSecretFetcher(baseUrl);

	// Resolve the provider token first so process.env is populated before any
	// downstream code that reads it. Both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN
	// are set, mirroring the dual-header pattern in buildProviderEnv: the bundled
	// Agent SDK auth factory prefers ANTHROPIC_API_KEY, but third-party proxies
	// sometimes accept only ANTHROPIC_AUTH_TOKEN.
	const providerToken = await fetcher.get(config.provider.secret_name);
	process.env.ANTHROPIC_API_KEY = providerToken;
	process.env.ANTHROPIC_AUTH_TOKEN = providerToken;

	await interpolateSecretsInPlace(config as unknown as Record<string, unknown>, fetcher);

	return config;
}

/**
 * Recursively walk an object tree. For every string-typed leaf whose value
 * matches `${secret:NAME}` as the WHOLE string, replace it with the resolved
 * plaintext. Plain nested objects recurse; arrays and other non-plain values
 * are skipped (no schema field is array-of-strings today, and adding array
 * support speculatively would expand the security surface).
 *
 * Mutates `obj` in place; returns `Promise<void>`.
 */
async function interpolateSecretsInPlace(obj: Record<string, unknown>, fetcher: MetadataSecretFetcher): Promise<void> {
	for (const [key, value] of Object.entries(obj)) {
		if (typeof value === "string") {
			const match = value.match(SECRET_REF_REGEX);
			if (match) {
				const name = match[1];
				if (name) {
					obj[key] = await fetcher.get(name);
				}
			}
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			await interpolateSecretsInPlace(value as Record<string, unknown>, fetcher);
		}
	}
}

/**
 * Load channel configurations with environment variable substitution.
 * Returns null if the config file doesn't exist (channels are optional).
 */
export function loadChannelsConfig(path?: string): ChannelsConfig | null {
	const configPath = path ?? DEFAULT_CHANNELS_PATH;

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch {
		return null;
	}

	// Substitute ${ENV_VAR} references with actual environment values
	text = text.replace(/\$\{(\w+)\}/g, (_, varName) => {
		return process.env[varName] ?? "";
	});

	const parsed: unknown = parse(text);

	const result = ChannelsConfigSchema.safeParse(parsed);
	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		console.warn(`[config] Invalid channels config at ${configPath}:\n${issues}`);
		return null;
	}

	return result.data;
}
