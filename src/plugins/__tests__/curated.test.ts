import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetCuratedCacheForTests, loadCuratedOverlay, lookupCuratedEntry } from "../curated.ts";

let tmp: string;
let path: string;

beforeEach(() => {
	__resetCuratedCacheForTests();
	tmp = mkdtempSync(join(tmpdir(), "phantom-curated-"));
	path = join(tmp, "plugins-curated.json");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("loadCuratedOverlay", () => {
	test("returns empty overlay when file is missing", () => {
		const overlay = loadCuratedOverlay(path);
		expect(overlay).toEqual({ version: 1, plugins: {} });
	});

	test("parses an empty-but-valid overlay", () => {
		writeFileSync(path, '{"version":1,"plugins":{}}');
		const overlay = loadCuratedOverlay(path);
		expect(overlay.plugins).toEqual({});
	});

	test("parses a populated overlay", () => {
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				plugins: {
					"notion@claude-plugins-official": {
						tags: ["phantom-recommended", "production-tested"],
						audience: ["founder", "pm"],
						note: "Phantom default.",
					},
				},
			}),
		);
		const overlay = loadCuratedOverlay(path);
		const entry = lookupCuratedEntry(overlay, "notion@claude-plugins-official");
		expect(entry).not.toBeNull();
		expect(entry?.tags).toContain("phantom-recommended");
	});

	test("returns empty on malformed JSON", () => {
		writeFileSync(path, "{ not json");
		const overlay = loadCuratedOverlay(path);
		expect(overlay).toEqual({ version: 1, plugins: {} });
	});

	test("returns empty on schema violation", () => {
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				plugins: { "notion@claude-plugins-official": { tags: ["not-a-real-tag"] } },
			}),
		);
		const overlay = loadCuratedOverlay(path);
		expect(overlay).toEqual({ version: 1, plugins: {} });
	});

	test("returns empty on wrong version", () => {
		writeFileSync(path, '{"version":2,"plugins":{}}');
		const overlay = loadCuratedOverlay(path);
		expect(overlay).toEqual({ version: 1, plugins: {} });
	});

	test("caches by mtime", () => {
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				plugins: { "a@b": { tags: ["phantom-recommended"] } },
			}),
		);
		const first = loadCuratedOverlay(path);
		const second = loadCuratedOverlay(path);
		expect(first).toBe(second); // same reference on cache hit
	});
});
