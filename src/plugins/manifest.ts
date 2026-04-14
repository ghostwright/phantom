// Zod schemas for the claude-plugins-official marketplace.json, the plugin
// entry shape Phantom renders in its browser, the curated metadata overlay,
// and the settings.json `enabledPlugins` shape.
//
// Every field Phantom reads is declared here. PR1's Codex P2 lesson: if you
// have a strict Zod schema and you read an optional marker field, declare it
// in the schema or the field is unreachable. We apply that discipline: every
// field the dashboard or audit log ever touches has a slot in the schema.
//
// The schemas are intentionally permissive on fields Phantom does not use
// (authors, tags, lspServers, keywords) via a passthrough tail. The fields
// Phantom DOES use are strictly validated.

import { z } from "zod";

// Transport types supported by Claude Code's plugin resolver. PR2 v1 only
// renders url, github, and local sources. git-subdir, npm, pip exist in the
// schema for forward-compat but the dashboard filters them out with a
// "coming in a later release" footnote. Declaring them here means we still
// parse the upstream marketplace cleanly.
export const PluginSourceTypeSchema = z.enum(["url", "github", "git", "git-subdir", "npm", "pip", "file", "directory"]);

export type PluginSourceType = z.infer<typeof PluginSourceTypeSchema>;

// Upstream source field is either a relative path string ("./plugins/foo")
// or an object with a source discriminator. We preserve both forms and
// normalize to a tagged union at the merge step.
export const PluginSourceObjectSchema = z
	.object({
		source: PluginSourceTypeSchema,
		url: z.string().optional(),
		repo: z.string().optional(),
		ref: z.string().optional(),
		path: z.string().optional(),
		sha: z.string().optional(),
		sparsePaths: z.array(z.string()).optional(),
		package: z.string().optional(),
		headers: z.record(z.string()).optional(),
	})
	.passthrough();

export const PluginSourceSchema = z.union([z.string(), PluginSourceObjectSchema]);

export type PluginSource = z.infer<typeof PluginSourceSchema>;

// Normalized shape the dashboard actually renders per card. Every field is
// declared; no passthrough. This is the contract between the fetcher and the
// UI.
export const NormalizedPluginSchema = z
	.object({
		name: z.string().min(1),
		marketplace: z.string().min(1),
		description: z.string().default(""),
		source_type: z.enum(["url", "github", "local", "git", "git-subdir", "npm", "pip", "file", "directory"]),
		source_url: z.string().nullable(),
		category: z.string().nullable(),
		homepage: z.string().nullable(),
		version: z.string().nullable(),
		tags: z.array(z.string()).default([]),
		curated_tags: z.array(z.string()).default([]),
		curated_note: z.string().nullable(),
		audience: z.array(z.string()).default([]),
		pinned_version: z.string().nullable(),
		enabled: z.boolean().default(false),
	})
	.strict();

export type NormalizedPlugin = z.infer<typeof NormalizedPluginSchema>;

// The upstream plugin entry as it appears in marketplace.json. We only
// strictly validate the fields we read and use passthrough for everything
// else so upstream schema additions do not break us.
export const UpstreamPluginSchema = z
	.object({
		name: z.string().min(1),
		description: z.string().optional(),
		category: z.string().optional(),
		source: PluginSourceSchema.optional(),
		homepage: z.string().optional(),
		version: z.string().optional(),
		author: z
			.union([z.string(), z.object({ name: z.string().optional(), email: z.string().optional() }).passthrough()])
			.optional(),
		tags: z.array(z.string()).optional(),
		keywords: z.array(z.string()).optional(),
		skills: z.array(z.string()).optional(),
		// Upstream lspServers is a Record<string, LspServerConfig> keyed by server name
		// (e.g. {"clangd": {...}}), not an array. We do not render this field anywhere,
		// so accept any shape and let .passthrough() keep it on the parsed object for
		// future use. Strict typing here would reject ~12 real plugins from the catalog.
		lspServers: z.unknown().optional(),
		strict: z.boolean().optional(),
	})
	.passthrough();

export type UpstreamPlugin = z.infer<typeof UpstreamPluginSchema>;

export const MarketplaceOwnerSchema = z
	.object({
		name: z.string().optional(),
		email: z.string().optional(),
	})
	.passthrough();

export const MarketplaceSchema = z
	.object({
		$schema: z.string().optional(),
		name: z.string().min(1),
		description: z.string().optional(),
		owner: MarketplaceOwnerSchema.optional(),
		plugins: z.array(UpstreamPluginSchema),
	})
	.passthrough();

export type Marketplace = z.infer<typeof MarketplaceSchema>;

// ----- Curated overlay schema (see research file 05) -----

export const CuratedTagSchema = z.enum(["phantom-recommended", "production-tested", "experimental", "deprecated"]);

export type CuratedTag = z.infer<typeof CuratedTagSchema>;

export const CuratedEntrySchema = z
	.object({
		tags: z.array(CuratedTagSchema).optional(),
		category: z.string().optional(),
		audience: z.array(z.string()).optional(),
		note: z.string().max(280).optional(),
		pinned_version: z.string().nullable().optional(),
		last_reviewed: z.string().optional(),
	})
	.strict();

export type CuratedEntry = z.infer<typeof CuratedEntrySchema>;

export const CuratedOverlaySchema = z
	.object({
		$schema: z.string().optional(),
		version: z.literal(1),
		plugins: z.record(CuratedEntrySchema).default({}),
	})
	.strict();

export type CuratedOverlay = z.infer<typeof CuratedOverlaySchema>;

// ----- enabledPlugins schema -----
//
// The value of each enabledPlugins entry can be `true`, `false`, a
// string[] (version constraints), or an object. We accept all four. We
// treat `false` and missing entries as uninstalled. Everything else is
// installed. (The CLI uses `false` instead of deleting keys on uninstall.)

export const EnabledPluginValueSchema = z.union([z.boolean(), z.array(z.string()), z.record(z.unknown())]);

export type EnabledPluginValue = z.infer<typeof EnabledPluginValueSchema>;

export const EnabledPluginsMapSchema = z.record(EnabledPluginValueSchema);

export type EnabledPluginsMap = z.infer<typeof EnabledPluginsMapSchema>;

export function isEnabledValueActive(value: EnabledPluginValue | undefined): boolean {
	if (value === undefined) return false;
	if (value === false) return false;
	if (value === true) return true;
	if (Array.isArray(value)) return value.length > 0;
	if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
	return false;
}

// Normalize the upstream source field to the flat `(type, url)` shape the
// dashboard renders. This is the single place that handles the two upstream
// representations (string "./..." vs object).
export function normalizeSource(source: PluginSource | undefined): {
	source_type: NormalizedPlugin["source_type"];
	source_url: string | null;
} {
	if (source === undefined) {
		return { source_type: "local", source_url: null };
	}
	if (typeof source === "string") {
		return { source_type: "local", source_url: source };
	}
	const type = source.source;
	const url = source.url ?? source.repo ?? source.package ?? source.path ?? null;
	return { source_type: type, source_url: url };
}
