// Loader for the Phantom-curated plugin metadata overlay.
//
// The file lives at config/plugins-curated.json (repo root, beside the other
// config yaml files). It is a simple JSON document with an optional entry
// per plugin-id@marketplace-id key. Entries annotate the upstream marketplace
// entry with Phantom-specific tags, notes, audience, and optional version
// pinning. See research file 05 for the full design.
//
// The loader is defensive: a missing, unreadable, or malformed overlay does
// NOT break the plugins tab. It returns an empty overlay and logs one warning.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type CuratedOverlay, CuratedOverlaySchema } from "./manifest.ts";

const DEFAULT_OVERLAY: CuratedOverlay = { version: 1, plugins: {} };

export function getCuratedOverlayPath(): string {
	const override = process.env.PHANTOM_CURATED_OVERLAY_PATH;
	if (override) {
		return resolve(override);
	}
	return resolve(process.cwd(), "config", "plugins-curated.json");
}

// In-memory cache keyed by mtime so reloads are cheap.
type CacheSlot = { mtimeMs: number; overlay: CuratedOverlay };
let cache: { path: string; slot: CacheSlot } | null = null;

export function loadCuratedOverlay(pathOverride?: string): CuratedOverlay {
	const path = pathOverride ?? getCuratedOverlayPath();

	if (!existsSync(path)) {
		return DEFAULT_OVERLAY;
	}

	let mtimeMs: number;
	try {
		mtimeMs = statSync(path).mtimeMs;
	} catch {
		return DEFAULT_OVERLAY;
	}

	if (cache && cache.path === path && cache.slot.mtimeMs === mtimeMs) {
		return cache.slot.overlay;
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[plugins] curated overlay read failed (${path}): ${msg}`);
		return DEFAULT_OVERLAY;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[plugins] curated overlay is not valid JSON (${path}): ${msg}`);
		return DEFAULT_OVERLAY;
	}

	const result = CuratedOverlaySchema.safeParse(parsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const where = issue.path.length > 0 ? issue.path.join(".") : "root";
		console.warn(`[plugins] curated overlay schema error (${path}) at ${where}: ${issue.message}`);
		return DEFAULT_OVERLAY;
	}

	const overlay: CuratedOverlay = result.data;
	cache = { path, slot: { mtimeMs, overlay } };
	return overlay;
}

// Test-only: force a cache drop. Invoked by the curated.test.ts file.
export function __resetCuratedCacheForTests(): void {
	cache = null;
}

export function lookupCuratedEntry(
	overlay: CuratedOverlay,
	pluginKey: string,
): CuratedOverlay["plugins"][string] | null {
	return overlay.plugins[pluginKey] ?? null;
}
