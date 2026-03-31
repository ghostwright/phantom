import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const EvolutionConfigSchema = z.object({
	cadence: z
		.object({
			reflection_interval: z.number().int().positive().default(1),
			consolidation_interval: z.number().int().positive().default(10),
			full_review_interval: z.number().int().positive().default(50),
			drift_check_interval: z.number().int().positive().default(20),
		})
		.default({}),
	gates: z
		.object({
			drift_threshold: z.number().min(0).max(1).default(0.7),
			max_file_lines: z.number().int().positive().default(200),
			auto_rollback_threshold: z.number().min(0).max(1).default(0.1),
			auto_rollback_window: z.number().int().positive().default(5),
		})
		.default({}),
	reflection: z
		.object({
			model: z.string().default("claude-sonnet-4-20250514"),
			effort: z.enum(["low", "medium", "high", "max"]).default("high"),
			max_budget_usd: z.number().positive().default(0.5),
		})
		.default({}),
	judges: z
		.object({
			enabled: z.enum(["auto", "always", "never"]).default("auto"),
			cost_cap_usd_per_day: z.number().positive().default(50.0),
			max_golden_suite_size: z.number().int().positive().default(50),
		})
		.default({}),
	paths: z
		.object({
			config_dir: z.string().default("phantom-config"),
			constitution: z.string().default("phantom-config/constitution.md"),
			version_file: z.string().default("phantom-config/meta/version.json"),
			metrics_file: z.string().default("phantom-config/meta/metrics.json"),
			evolution_log: z.string().default("phantom-config/meta/evolution-log.jsonl"),
			golden_suite: z.string().default("phantom-config/meta/golden-suite.jsonl"),
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
