import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { type ChannelsConfig, ChannelsConfigSchema, PhantomConfigSchema } from "./schemas.ts";
import type { PhantomConfig } from "./types.ts";

const DEFAULT_CONFIG_PATH = "config/phantom.yaml";
const DEFAULT_CHANNELS_PATH = "config/channels.yaml";

export function loadConfig(path?: string): PhantomConfig {
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
