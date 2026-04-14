import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../../db/schema.ts";
import { __resetCuratedCacheForTests } from "../curated.ts";
import { type FetchMarketplaceFn, getCatalog, resolveMarketplace } from "../marketplace.ts";

function createTestDb(): Database {
	const db = new Database(":memory:");
	for (const stmt of MIGRATIONS) {
		db.run(stmt);
	}
	return db;
}

const FIXTURE_BODY = JSON.stringify({
	$schema: "https://anthropic.com/claude-code/marketplace.schema.json",
	name: "claude-plugins-official",
	description: "Test",
	owner: { name: "Anthropic" },
	plugins: [
		{
			name: "notion",
			description: "Notion workspace integration.",
			category: "productivity",
			source: { source: "url", url: "https://github.com/makenotion/claude-code-notion-plugin.git" },
			homepage: "https://github.com/makenotion/claude-code-notion-plugin",
		},
		{
			name: "linear",
			description: "Linear issue tracking.",
			category: "productivity",
			source: "./external_plugins/linear",
		},
		{
			name: "slack",
			description: "Slack workspace.",
			category: "productivity",
			source: { source: "url", url: "https://github.com/slackapi/slack-mcp-plugin.git" },
		},
		{
			name: "claude-md-management",
			description: "Maintain CLAUDE.md files.",
			author: { name: "Anthropic" },
			source: "./plugins/claude-md-management",
			category: "productivity",
		},
		{
			name: "expo",
			description: "Expo skills.",
			source: { source: "git-subdir", url: "expo/skills" },
			category: "development",
		},
		{
			name: "stagehand",
			description: "Stagehand browser automation.",
			source: { source: "github", repo: "example/stagehand" },
			category: "automation",
		},
	],
});

let db: Database;
let tmpDir: string;
let overlayPath: string;

beforeEach(() => {
	__resetCuratedCacheForTests();
	db = createTestDb();
	tmpDir = mkdtempSync(join(tmpdir(), "phantom-marketplace-"));
	overlayPath = join(tmpDir, "curated.json");
	writeFileSync(overlayPath, '{"version":1,"plugins":{}}');
});

afterEach(() => {
	db.close();
	rmSync(tmpDir, { recursive: true, force: true });
});

function makeFetcher(body: string = FIXTURE_BODY): FetchMarketplaceFn {
	let calls = 0;
	const fn: FetchMarketplaceFn & { calls: () => number } = Object.assign(
		async () => {
			calls += 1;
			return { ok: true, body, etag: "test-etag" };
		},
		{ calls: () => calls },
	);
	return fn;
}

describe("resolveMarketplace", () => {
	test("fetches and caches on first call", async () => {
		const fetcher = makeFetcher() as FetchMarketplaceFn & { calls: () => number };
		const result = await resolveMarketplace({ db, fetcher });
		expect(result.cacheHit).toBe(false);
		expect(result.marketplace.plugins).toHaveLength(6);
		expect(fetcher.calls()).toBe(1);
	});

	test("serves from cache within TTL", async () => {
		const fetcher = makeFetcher() as FetchMarketplaceFn & { calls: () => number };
		await resolveMarketplace({ db, fetcher });
		const second = await resolveMarketplace({ db, fetcher });
		expect(second.cacheHit).toBe(true);
		expect(second.fromStaleCache).toBe(false);
		expect(fetcher.calls()).toBe(1);
	});

	test("force refresh bypasses cache", async () => {
		const fetcher = makeFetcher() as FetchMarketplaceFn & { calls: () => number };
		await resolveMarketplace({ db, fetcher });
		await resolveMarketplace({ db, fetcher, forceRefresh: true });
		expect(fetcher.calls()).toBe(2);
	});

	test("stale-while-error serves cache when fetch fails", async () => {
		const good = makeFetcher() as FetchMarketplaceFn & { calls: () => number };
		await resolveMarketplace({ db, fetcher: good });
		const bad: FetchMarketplaceFn = async () => ({ ok: false, body: "", etag: null });
		const result = await resolveMarketplace({ db, fetcher: bad, forceRefresh: true });
		expect(result.cacheHit).toBe(true);
		expect(result.fromStaleCache).toBe(true);
	});

	test("throws when fetch fails and no cache exists", async () => {
		const bad: FetchMarketplaceFn = async () => ({ ok: false, body: "", etag: null });
		await expect(resolveMarketplace({ db, fetcher: bad })).rejects.toThrow(/unreachable/);
	});

	test("rejects an invalid body but keeps previous cache", async () => {
		const good = makeFetcher();
		await resolveMarketplace({ db, fetcher: good });
		const badBody: FetchMarketplaceFn = async () => ({ ok: true, body: "{ not a marketplace }", etag: null });
		const result = await resolveMarketplace({ db, fetcher: badBody, forceRefresh: true });
		expect(result.cacheHit).toBe(true);
		expect(result.fromStaleCache).toBe(true);
	});
});

describe("getCatalog", () => {
	test("filters unsupported transports and counts them", async () => {
		const fetcher = makeFetcher();
		const catalog = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		// 6 plugins total, expo(git-subdir) filtered -> 5 rendered, 1 hidden
		expect(catalog.plugins).toHaveLength(5);
		expect(catalog.hidden_by_transport).toBe(1);
		const names = catalog.plugins.map((p) => p.name);
		expect(names).toContain("notion");
		expect(names).toContain("linear");
		expect(names).toContain("slack");
		expect(names).toContain("claude-md-management");
		expect(names).toContain("stagehand");
		expect(names).not.toContain("expo");
	});

	test("marks active plugins as enabled", async () => {
		const fetcher = makeFetcher();
		const active = new Set(["notion@claude-plugins-official", "slack@claude-plugins-official"]);
		const catalog = await getCatalog({ db, fetcher, activeKeys: active, overlayPath });
		const notion = catalog.plugins.find((p) => p.name === "notion");
		expect(notion?.enabled).toBe(true);
		const linear = catalog.plugins.find((p) => p.name === "linear");
		expect(linear?.enabled).toBe(false);
	});

	test("merges curated overlay tags and notes", async () => {
		writeFileSync(
			overlayPath,
			JSON.stringify({
				version: 1,
				plugins: {
					"notion@claude-plugins-official": {
						tags: ["phantom-recommended"],
						note: "Default pick.",
						audience: ["founder", "pm"],
					},
				},
			}),
		);
		const fetcher = makeFetcher();
		const catalog = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		const notion = catalog.plugins.find((p) => p.name === "notion");
		expect(notion?.curated_tags).toContain("phantom-recommended");
		expect(notion?.curated_note).toBe("Default pick.");
		expect(notion?.audience).toContain("founder");
	});

	test("phantom-recommended sorts to the top", async () => {
		writeFileSync(
			overlayPath,
			JSON.stringify({
				version: 1,
				plugins: {
					"slack@claude-plugins-official": { tags: ["phantom-recommended"] },
				},
			}),
		);
		const fetcher = makeFetcher();
		const catalog = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		expect(catalog.plugins[0].name).toBe("slack");
	});

	test("normalizes local source type to 'local'", async () => {
		const fetcher = makeFetcher();
		const catalog = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		const linear = catalog.plugins.find((p) => p.name === "linear");
		expect(linear?.source_type).toBe("local");
		expect(linear?.source_url).toBe("./external_plugins/linear");
	});

	test("normalizes url source type and keeps the URL", async () => {
		const fetcher = makeFetcher();
		const catalog = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		const notion = catalog.plugins.find((p) => p.name === "notion");
		expect(notion?.source_type).toBe("url");
		expect(notion?.source_url).toContain("makenotion");
	});

	test("returns fetched_at and cache flags", async () => {
		const fetcher = makeFetcher();
		const first = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		const second = await getCatalog({ db, fetcher, activeKeys: new Set(), overlayPath });
		expect(first.cache_hit).toBe(false);
		expect(second.cache_hit).toBe(true);
		expect(first.fetched_at).toBeTruthy();
	});
});
