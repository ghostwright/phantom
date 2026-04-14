// Resolve and validate plugin-related filesystem paths.
//
// Plugins in Claude Code live under the user-scope `.claude` directory on
// disk: settings.json declares which plugins are enabled and the CLI clones
// each plugin under `~/.claude/plugins/` on next query init. Phantom never
// writes to the plugin cache itself; it only writes to settings.json and
// lets the CLI subprocess do the clone + manifest validation + load.
//
// Responsibilities here:
//   - locate the user-scope settings.json (/home/phantom/.claude/settings.json)
//   - locate the plugin cache root (/home/phantom/.claude/plugins/) for
//     read-only listing inside the audit tab
//   - validate plugin keys of the form `plugin-id@marketplace-id`

import { homedir } from "node:os";
import { resolve } from "node:path";

const CLAUDE_ROOT_OVERRIDE = "PHANTOM_CLAUDE_ROOT";

// Same character set the Claude Code CLI uses for plugin and marketplace ids:
// lowercase letters, digits, hyphens, underscores. Length bounded so a hostile
// write cannot try to bloat the audit log or filesystem.
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const MARKETPLACE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function getClaudeRoot(): string {
	const override = process.env[CLAUDE_ROOT_OVERRIDE];
	if (override) {
		return resolve(override);
	}
	return resolve(homedir(), ".claude");
}

export function getUserSettingsPath(): string {
	return resolve(getClaudeRoot(), "settings.json");
}

export function getPluginCacheRoot(): string {
	return resolve(getClaudeRoot(), "plugins");
}

export function isValidPluginId(id: string): boolean {
	if (typeof id !== "string") return false;
	if (id.includes("\0")) return false;
	return PLUGIN_ID_PATTERN.test(id);
}

export function isValidMarketplaceId(id: string): boolean {
	if (typeof id !== "string") return false;
	if (id.includes("\0")) return false;
	return MARKETPLACE_ID_PATTERN.test(id);
}

export type PluginKey = {
	plugin: string;
	marketplace: string;
};

// Parse a `plugin-id@marketplace-id` key. Returns null if either half is
// missing or invalid.
export function parsePluginKey(key: string): PluginKey | null {
	if (typeof key !== "string") return null;
	const at = key.lastIndexOf("@");
	if (at <= 0 || at === key.length - 1) return null;
	const plugin = key.slice(0, at);
	const marketplace = key.slice(at + 1);
	if (!isValidPluginId(plugin)) return null;
	if (!isValidMarketplaceId(marketplace)) return null;
	return { plugin, marketplace };
}

export function formatPluginKey(plugin: string, marketplace: string): string {
	if (!isValidPluginId(plugin)) {
		throw new Error(`Invalid plugin id: ${JSON.stringify(plugin)}`);
	}
	if (!isValidMarketplaceId(marketplace)) {
		throw new Error(`Invalid marketplace id: ${JSON.stringify(marketplace)}`);
	}
	return `${plugin}@${marketplace}`;
}

export const OFFICIAL_MARKETPLACE_ID = "claude-plugins-official";
