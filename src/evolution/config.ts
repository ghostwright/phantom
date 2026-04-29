import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// Phase 3 evolution config schema.
//
// The 6-judge pipeline deletion removed most of the legacy knobs. What
// remains is paths plus a reflection enable flag. The cadence cron
// interval and demand trigger depth live in `phantom-config/meta/evolution.json`
// (see `loadCadenceConfig` in cadence.ts), not in this YAML, because the
// operator wants to tune them without touching the repo config.

export const EvolutionConfigSchema = z.object({
	reflection: z
		.object({
			enabled: z.enum(["auto", "always", "never"]).default("auto"),
		})
		.default({}),
	paths: z
		.object({
			config_dir: z.string().default("phantom-config"),
			constitution: z.string().default("phantom-config/constitution.md"),
			version_file: z.string().default("phantom-config/meta/version.json"),
			metrics_file: z.string().default("phantom-config/meta/metrics.json"),
			evolution_log: z.string().default("phantom-config/meta/evolution-log.jsonl"),
			session_log: z.string().default("phantom-config/memory/session-log.jsonl"),
		})
		.default({}),
});

export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>;

const DEFAULT_CONFIG_PATH = "config/evolution.yaml";

export function loadEvolutionConfig(path?: string): EvolutionConfig {
	const configPath = path ?? DEFAULT_CONFIG_PATH;

	let text: string;
	try {
		text = readFileSync(configPath, "utf-8");
	} catch {
		console.warn(`[evolution] No config at ${configPath}, using defaults`);
		return EvolutionConfigSchema.parse({});
	}

	const parsed: unknown = parse(text);
	const result = EvolutionConfigSchema.safeParse(parsed);

	if (!result.success) {
		const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
		console.warn(`[evolution] Invalid config at ${configPath}, using defaults:\n${issues}`);
		return EvolutionConfigSchema.parse({});
	}

	return result.data;
}
