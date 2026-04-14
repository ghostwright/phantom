// Marketplace fetcher with TTL cache + curated overlay merge.
//
// Fetches claude-plugins-official marketplace.json from the raw GitHub CDN,
// caches the raw document in SQLite so the dashboard renders instantly on
// subsequent loads, normalizes each upstream entry to the shape the dashboard
// expects, filters out unsupported transports per the PR2 v1 scope, and
// merges the Phantom curated overlay on top.
//
// The fetch is not on the hot path: the dashboard calls this once per tab
// open and the TTL is 10 minutes. If the fetch fails, we serve the cached
// document even if it is past TTL (stale-while-error) so a network blip
// never breaks the plugins tab.

import type { Database } from "bun:sqlite";
import { loadCuratedOverlay, lookupCuratedEntry } from "./curated.ts";
import {
	type CuratedOverlay,
	type Marketplace,
	MarketplaceSchema,
	type NormalizedPlugin,
	type UpstreamPlugin,
	normalizeSource,
} from "./manifest.ts";
import { OFFICIAL_MARKETPLACE_ID } from "./paths.ts";

// v1 scope: url, github, local are rendered in the browser. git, git-subdir,
// npm, pip, file, and directory entries are filtered out with an informational
// footnote. This is the brief's explicit constraint.
const SUPPORTED_SOURCE_TYPES: ReadonlySet<NormalizedPlugin["source_type"]> = new Set(["url", "github", "local"]);

const OFFICIAL_MARKETPLACE_URL =
	"https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export type MarketplaceCacheRow = {
	marketplace_id: string;
	etag: string | null;
	fetched_at: string;
	body: string;
};

export function ensureMarketplaceCacheTable(db: Database): void {
	db.run(
		`CREATE TABLE IF NOT EXISTS plugin_marketplace_cache (
			marketplace_id TEXT PRIMARY KEY,
			etag TEXT,
			fetched_at TEXT NOT NULL,
			body TEXT NOT NULL
		)`,
	);
}

function readCachedRow(db: Database, marketplaceId: string): MarketplaceCacheRow | null {
	const row = db
		.query("SELECT marketplace_id, etag, fetched_at, body FROM plugin_marketplace_cache WHERE marketplace_id = ?")
		.get(marketplaceId) as MarketplaceCacheRow | null;
	return row;
}

function writeCachedRow(db: Database, marketplaceId: string, body: string, etag: string | null): void {
	db.run(
		`INSERT INTO plugin_marketplace_cache (marketplace_id, etag, fetched_at, body)
		 VALUES (?, ?, datetime('now'), ?)
		 ON CONFLICT(marketplace_id) DO UPDATE SET
		   etag = excluded.etag,
		   fetched_at = excluded.fetched_at,
		   body = excluded.body`,
		[marketplaceId, etag, body],
	);
}

function cacheAgeMs(row: MarketplaceCacheRow): number {
	return Date.now() - Date.parse(`${row.fetched_at}Z`);
}

// Injectable fetcher so tests never hit the network.
export type FetchMarketplaceFn = (url: string) => Promise<{ ok: boolean; body: string; etag: string | null }>;

const defaultFetcher: FetchMarketplaceFn = async (url: string) => {
	const response = await fetch(url, { headers: { Accept: "application/json" } });
	if (!response.ok) {
		return { ok: false, body: "", etag: null };
	}
	const body = await response.text();
	const etag = response.headers.get("etag");
	return { ok: true, body, etag };
};

export type MarketplaceResolveOptions = {
	db: Database;
	fetcher?: FetchMarketplaceFn;
	ttlMs?: number;
	marketplaceId?: string;
	marketplaceUrl?: string;
	forceRefresh?: boolean;
};

export type MarketplaceResolveResult = {
	marketplace: Marketplace;
	fetchedAt: string;
	cacheHit: boolean;
	fromStaleCache: boolean;
};

export async function resolveMarketplace(options: MarketplaceResolveOptions): Promise<MarketplaceResolveResult> {
	const {
		db,
		fetcher = defaultFetcher,
		ttlMs = DEFAULT_TTL_MS,
		marketplaceId = OFFICIAL_MARKETPLACE_ID,
		marketplaceUrl = OFFICIAL_MARKETPLACE_URL,
		forceRefresh = false,
	} = options;

	ensureMarketplaceCacheTable(db);

	const cached = readCachedRow(db, marketplaceId);

	if (!forceRefresh && cached && cacheAgeMs(cached) < ttlMs) {
		const parsed = MarketplaceSchema.parse(JSON.parse(cached.body));
		return { marketplace: parsed, fetchedAt: cached.fetched_at, cacheHit: true, fromStaleCache: false };
	}

	let fetched: Awaited<ReturnType<FetchMarketplaceFn>>;
	try {
		fetched = await fetcher(marketplaceUrl);
	} catch (err: unknown) {
		if (cached) {
			const parsed = MarketplaceSchema.parse(JSON.parse(cached.body));
			return { marketplace: parsed, fetchedAt: cached.fetched_at, cacheHit: true, fromStaleCache: true };
		}
		const msg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to fetch marketplace ${marketplaceId}: ${msg}`);
	}

	if (!fetched.ok) {
		if (cached) {
			const parsed = MarketplaceSchema.parse(JSON.parse(cached.body));
			return { marketplace: parsed, fetchedAt: cached.fetched_at, cacheHit: true, fromStaleCache: true };
		}
		throw new Error(`Marketplace ${marketplaceId} unreachable and no cache available`);
	}

	// Validate before caching so malformed bodies never poison the cache.
	let parsedDoc: Marketplace;
	try {
		parsedDoc = MarketplaceSchema.parse(JSON.parse(fetched.body));
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (cached) {
			const prev = MarketplaceSchema.parse(JSON.parse(cached.body));
			return { marketplace: prev, fetchedAt: cached.fetched_at, cacheHit: true, fromStaleCache: true };
		}
		throw new Error(`Marketplace ${marketplaceId} response invalid: ${msg}`);
	}

	writeCachedRow(db, marketplaceId, fetched.body, fetched.etag);
	const now = new Date().toISOString().replace("T", " ").replace(/\..*/, "");
	return { marketplace: parsedDoc, fetchedAt: now, cacheHit: false, fromStaleCache: false };
}

// ----- Normalization and curated merge -----

export function normalizeUpstream(
	upstream: UpstreamPlugin,
	marketplaceId: string,
	overlay: CuratedOverlay,
	activeKeys: Set<string>,
): NormalizedPlugin {
	const { source_type, source_url } = normalizeSource(upstream.source);
	const key = `${upstream.name}@${marketplaceId}`;
	const curated = lookupCuratedEntry(overlay, key);
	return {
		name: upstream.name,
		marketplace: marketplaceId,
		description: upstream.description ?? "",
		source_type,
		source_url,
		category: curated?.category ?? upstream.category ?? null,
		homepage: upstream.homepage ?? null,
		version: upstream.version ?? null,
		tags: upstream.tags ?? [],
		curated_tags: curated?.tags ?? [],
		curated_note: curated?.note ?? null,
		audience: curated?.audience ?? [],
		pinned_version: curated?.pinned_version ?? null,
		enabled: activeKeys.has(key),
	};
}

export type CatalogOptions = {
	db: Database;
	fetcher?: FetchMarketplaceFn;
	ttlMs?: number;
	activeKeys: Set<string>;
	overlayPath?: string;
	forceRefresh?: boolean;
};

export type Catalog = {
	marketplace: string;
	plugins: NormalizedPlugin[];
	hidden_by_transport: number; // count of filtered entries so the UI can show a footnote
	fetched_at: string;
	cache_hit: boolean;
	from_stale_cache: boolean;
};

export async function getCatalog(options: CatalogOptions): Promise<Catalog> {
	const overlay = loadCuratedOverlay(options.overlayPath);
	const resolved = await resolveMarketplace({
		db: options.db,
		fetcher: options.fetcher,
		ttlMs: options.ttlMs,
		forceRefresh: options.forceRefresh,
	});

	const normalized: NormalizedPlugin[] = [];
	let hidden = 0;
	for (const upstream of resolved.marketplace.plugins) {
		const flat = normalizeUpstream(upstream, resolved.marketplace.name, overlay, options.activeKeys);
		if (!SUPPORTED_SOURCE_TYPES.has(flat.source_type)) {
			hidden += 1;
			continue;
		}
		normalized.push(flat);
	}

	normalized.sort(sortNormalized);

	return {
		marketplace: resolved.marketplace.name,
		plugins: normalized,
		hidden_by_transport: hidden,
		fetched_at: resolved.fetchedAt,
		cache_hit: resolved.cacheHit,
		from_stale_cache: resolved.fromStaleCache,
	};
}

// Phantom-recommended floats to the top, then production-tested, then
// untagged, then experimental, then deprecated. Within each tier, sort by
// name ascending. Installed entries stay within their tier (installed state
// is surfaced by a badge, not by order).
export function sortNormalized(a: NormalizedPlugin, b: NormalizedPlugin): number {
	const tierA = curatedTier(a);
	const tierB = curatedTier(b);
	if (tierA !== tierB) return tierA - tierB;
	return a.name.localeCompare(b.name);
}

function curatedTier(p: NormalizedPlugin): number {
	if (p.curated_tags.includes("phantom-recommended")) return 0;
	if (p.curated_tags.includes("production-tested")) return 1;
	if (p.curated_tags.length === 0) return 2;
	if (p.curated_tags.includes("experimental")) return 3;
	if (p.curated_tags.includes("deprecated")) return 4;
	return 2;
}

export const SUPPORTED_TRANSPORT_LIST: ReadonlyArray<NormalizedPlugin["source_type"]> = ["url", "github", "local"];
