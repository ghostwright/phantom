// Pure helper extracted from runtime.ts so the init-plugin-snapshot path can be
// unit tested without spinning up the full agent main loop. Given an SDK init
// system message, extract the list of fully-qualified plugin keys the CLI
// resolved during boot and publish them to the dashboard SSE bus so the
// plugins card can flip to "installed" live.
//
// Field shape: verified against node_modules/@anthropic-ai/claude-agent-sdk/
// cli.js. The init system message constructs plugins as
//   plugins: A.plugins.map((z) => ({ name: z.name, path: z.path, source: z.source }))
// where `name` is the BARE plugin name (e.g. "linear") and `source` is the
// fully-qualified marketplace key (e.g. "linear@claude-plugins-official").
// Phantom's normalized plugin cards carry a synthetic key of the form
// `${name}@${marketplace}`, which matches the CLI's `source`. Reading `name`
// would flip cards across marketplaces if two ever shared a bare name, so
// we read `source` and fall back to `name` only if `source` is missing
// (for forward compat with future SDK shapes).

import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { publish as publishDashboardEvent } from "../ui/events.ts";

// The SDK's public `SDKSystemMessage` type declares `plugins` as
// `{name, path}[]` even though the runtime adds `source`. We widen the
// type here so TypeScript can catch shape drift on the fields Phantom
// actually reads while still tolerating the extra runtime field.
type PluginInitEntry = {
	name?: unknown;
	path?: unknown;
	source?: unknown;
};

export type InitMessageLike = (SDKSystemMessage & { plugins?: PluginInitEntry[] }) | null | undefined;

export function extractPluginKeys(message: InitMessageLike): string[] {
	if (!message || typeof message !== "object") return [];
	const plugins = (message as { plugins?: unknown }).plugins;
	if (!Array.isArray(plugins)) return [];
	const keys: string[] = [];
	for (const entry of plugins) {
		if (!entry || typeof entry !== "object") continue;
		const source = (entry as { source?: unknown }).source;
		if (typeof source === "string" && source.length > 0) {
			keys.push(source);
			continue;
		}
		// Fallback: older or future SDK versions may not populate
		// `source` on the init message. Fall back to the bare name so
		// the card flip still fires, even if less precisely.
		const name = (entry as { name?: unknown }).name;
		if (typeof name === "string" && name.length > 0) {
			keys.push(name);
		}
	}
	return keys;
}

export function emitPluginInitSnapshot(message: InitMessageLike): void {
	try {
		const keys = extractPluginKeys(message);
		publishDashboardEvent("plugin_init_snapshot", { keys });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[runtime] failed to emit plugin_init_snapshot: ${msg}`);
	}
}
