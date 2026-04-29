// First-boot default plugin seeder.
//
// Invoked from scripts/docker-entrypoint.sh on container start via
// `bun run src/plugins/seed.ts --apply`. Reads the user-scope settings.json
// at /home/phantom/.claude/settings.json (or whatever PHANTOM_CLAUDE_ROOT
// points at), and merges in Phantom's four default plugins if they are
// not already mentioned. The rule is "preserve operator choices": if the
// operator (or the agent) has already added or removed any of the picks
// since last boot, leave them alone.
//
// The picks are documented in research file 03 (default plugin picks) and
// represent the cross-role catalog Phantom ships with: linear, notion,
// slack, claude-md-management.

import { existsSync } from "node:fs";
import { OFFICIAL_MARKETPLACE_ID, formatPluginKey, getUserSettingsPath } from "./paths.ts";
import { readSettings, writeSettings } from "./settings-io.ts";

export type PluginPick = {
	plugin: string;
	marketplace: string;
	description: string;
};

export const DEFAULT_PLUGIN_PICKS: ReadonlyArray<PluginPick> = [
	{
		plugin: "linear",
		marketplace: OFFICIAL_MARKETPLACE_ID,
		description: "Linear issue tracking. Read issues, triage bugs, update statuses.",
	},
	{
		plugin: "notion",
		marketplace: OFFICIAL_MARKETPLACE_ID,
		description: "Notion workspace. Search pages, create docs, manage databases.",
	},
	{
		plugin: "slack",
		marketplace: OFFICIAL_MARKETPLACE_ID,
		description: "Slack workspace. Search messages across channels beyond Phantom's own threads.",
	},
	{
		plugin: "claude-md-management",
		marketplace: OFFICIAL_MARKETPLACE_ID,
		description: "Audits and improves your CLAUDE.md memory file.",
	},
];

export type SeedResult = {
	added: string[];
	skipped: string[];
	created: boolean;
};

export type SeedOptions = {
	// When true, compute the would-add and would-skip sets but do NOT write
	// settings.json. Used by the CLI dry-run path so operators can preview the
	// effect of `bun run src/plugins/seed.ts` before they pass --apply.
	dryRun?: boolean;
};

export function seedDefaultPlugins(
	picks: ReadonlyArray<PluginPick>,
	settingsPath: string = getUserSettingsPath(),
	options: SeedOptions = {},
): SeedResult {
	const dryRun = options.dryRun === true;
	const created = !existsSync(settingsPath);
	const read = readSettings(settingsPath);
	if (!read.ok) {
		throw new Error(`seedDefaultPlugins: ${read.error}`);
	}
	const settings = read.settings;
	const enabled = (settings.enabledPlugins ?? {}) as Record<string, unknown>;

	const added: string[] = [];
	const skipped: string[] = [];

	for (const pick of picks) {
		const key = formatPluginKey(pick.plugin, pick.marketplace);
		if (key in enabled) {
			skipped.push(key);
			continue;
		}
		enabled[key] = true;
		added.push(key);
	}

	if (added.length === 0 && created === false) {
		return { added, skipped, created: false };
	}

	if (dryRun) {
		// Report what would change, but never touch the file. The "created"
		// flag still reports the would-have-created state for an honest preview.
		return { added, skipped, created };
	}

	settings.enabledPlugins = enabled as typeof settings.enabledPlugins;
	const write = writeSettings(settings, settingsPath);
	if (!write.ok) {
		throw new Error(`seedDefaultPlugins: ${write.error}`);
	}

	return { added, skipped, created };
}

// CLI entrypoint. Invoked by docker-entrypoint.sh.
function main(): void {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(
			"Usage: bun run src/plugins/seed.ts [--apply]\n\n" +
				"  --apply   merge the four default Phantom plugins into the\n" +
				"            user-scope settings.json if they are not already\n" +
				"            present. Operator-edited entries are preserved.\n",
		);
		return;
	}
	const dryRun = !args.includes("--apply");
	if (dryRun) {
		process.stdout.write("[seed] Dry run mode (use --apply to write). No changes will be made.\n");
	}
	try {
		const result = seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, getUserSettingsPath(), { dryRun });
		const verb = dryRun ? "Would add" : "Added";
		const skipVerb = dryRun ? "Would preserve" : "Preserved";
		if (result.added.length > 0) {
			process.stdout.write(`[seed] ${verb} ${result.added.length} default plugin(s): ${result.added.join(", ")}\n`);
		}
		if (result.skipped.length > 0) {
			process.stdout.write(
				`[seed] ${skipVerb} ${result.skipped.length} existing plugin(s): ${result.skipped.join(", ")}\n`,
			);
		}
		if (result.added.length === 0 && result.skipped.length === 0) {
			process.stdout.write("[seed] No defaults configured.\n");
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[seed] Failed: ${msg}\n`);
		process.exit(1);
	}
}

if (import.meta.main) {
	main();
}
