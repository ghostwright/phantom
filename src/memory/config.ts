import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { MemoryConfigSchema } from "../config/schemas.ts";
import type { MemoryConfig } from "../config/types.ts";

const DEFAULT_CONFIG_PATH = "config/memory.yaml";

/**
 * Apply environment variable overrides for Docker and bare-metal compatibility.
 * CLAWMEM_STORE_PATH, CLAWMEM_EMBED_MODEL, and CLAWMEM_BUSY_TIMEOUT_MS
 * env vars take precedence over YAML config.
 */
function applyEnvOverrides(config: MemoryConfig): MemoryConfig {
	const storePath = readEnv(process.env.CLAWMEM_STORE_PATH);
	const embedModel = readEnv(process.env.CLAWMEM_EMBED_MODEL);
	const busyTimeoutMs = readEnv(process.env.CLAWMEM_BUSY_TIMEOUT_MS);
	const parsedBusyTimeout = busyTimeoutMs ? Number.parseInt(busyTimeoutMs, 10) : Number.NaN;

	return {
		...config,
		clawmem: {
			...config.clawmem,
			...(storePath ? { store_path: storePath } : {}),
			...(embedModel ? { embed_model: embedModel } : {}),
			...(Number.isFinite(parsedBusyTimeout) ? { busy_timeout_ms: parsedBusyTimeout } : {}),
		},
	};
}

export function loadMemoryConfig(path?: string): MemoryConfig {
	const configPath = path ?? DEFAULT_CONFIG_PATH;

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch {
		console.warn(
			`[memory] Config file not found at ${configPath}. Using defaults. Create config/memory.yaml to customize.`,
		);
		return applyEnvOverrides(MemoryConfigSchema.parse({}));
	}

	const parsed: unknown = parse(text);
	const result = MemoryConfigSchema.safeParse(parsed);

	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		console.warn(`[memory] Invalid config at ${configPath}:\n${issues}\nUsing defaults.`);
		return applyEnvOverrides(MemoryConfigSchema.parse({}));
	}

	return applyEnvOverrides(result.data);
}

function readEnv(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	return normalized === "" || normalized === "undefined" ? undefined : normalized;
}
