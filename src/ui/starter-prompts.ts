// Starter-prompt tiles for the landing page "What can <name> do?" section.
//
// Defaults ship in-process; operators override by dropping
// `phantom-config/starter-prompts.yaml` next to the other agent config. The
// YAML is schema-validated with Zod; any parse or validation failure logs a
// warning and falls back to the defaults so the landing page never renders
// blank.
//
// Cardinal Rule preservation: every field flows through as bytes. The loader
// does not inspect titles, descriptions, or prompts. No keyword branching, no
// intent classification. Tiles are static invitations; the agent decides what
// to do once the operator hits Send in the composer.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const STARTER_ICON_KEYS = ["chart", "git", "inbox", "metrics", "alert", "calendar", "search", "globe"] as const;

export const StarterTileSchema = z
	.object({
		icon: z.string().min(1).max(40),
		title: z.string().min(1).max(80),
		description: z.string().min(1).max(200),
		prompt: z.string().min(1).max(2000),
	})
	.strict();

export const StarterPromptsSchema = z
	.object({
		tiles: z.array(StarterTileSchema).min(1).max(6),
	})
	.strict();

export type StarterTile = z.infer<typeof StarterTileSchema>;

export const DEFAULT_STARTER_PROMPTS: readonly StarterTile[] = [
	{
		icon: "chart",
		title: "Summarize Hacker News",
		description: "Pull today's top stories and group them by theme.",
		prompt: "Summarize the top Hacker News stories from the last 24 hours, grouped by theme.",
	},
	{
		icon: "git",
		title: "Monitor my GitHub repos",
		description: "Check for new issues, PRs, and commits across my starred repos.",
		prompt: "Check for new issues and PRs on my GitHub repos since yesterday.",
	},
	{
		icon: "metrics",
		title: "Build a weekly metrics dashboard",
		description: "Create an HTML dashboard I can bookmark and watch.",
		prompt: "Build me a weekly metrics dashboard I can check every Monday morning.",
	},
	{
		icon: "alert",
		title: "Watch for production incidents",
		description: "Schedule a recurring watcher and alert me on Slack.",
		prompt: "Watch for production incidents and alert me on Slack if anything looks off.",
	},
	{
		icon: "inbox",
		title: "Triage my inbox",
		description: "Sort new emails by urgency and draft replies for the top few.",
		prompt: "Triage my inbox: sort by urgency and draft replies for the top three threads.",
	},
	{
		icon: "calendar",
		title: "Plan a sprint retrospective",
		description: "Summarize the last sprint and suggest discussion topics.",
		prompt: "Summarize the last sprint and suggest three discussion topics for the retro.",
	},
];

function defaultsCopy(): StarterTile[] {
	return DEFAULT_STARTER_PROMPTS.map((t) => ({ ...t }));
}

export function loadStarterPrompts(configDir: string): StarterTile[] {
	const filePath = resolve(configDir, "starter-prompts.yaml");
	if (!existsSync(filePath)) return defaultsCopy();

	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[starter-prompts] read failed (${msg}); using defaults`);
		return defaultsCopy();
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[starter-prompts] invalid YAML (${msg}); using defaults`);
		return defaultsCopy();
	}

	const check = StarterPromptsSchema.safeParse(parsed);
	if (!check.success) {
		const issue = check.error.issues[0];
		const where = issue?.path?.length ? issue.path.map((p) => String(p)).join(".") : "body";
		const message = issue?.message ?? "invalid input";
		console.warn(`[starter-prompts] schema rejected at ${where}: ${message}; using defaults`);
		return defaultsCopy();
	}

	return check.data.tiles;
}
