import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PLUGIN_PICKS, seedDefaultPlugins } from "../seed.ts";

let tmp: string;
let settingsPath: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-seed-"));
	settingsPath = join(tmp, "settings.json");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("seedDefaultPlugins", () => {
	test("creates settings.json and adds all four picks on a fresh container", () => {
		const result = seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath);
		expect(result.created).toBe(true);
		expect(result.added).toHaveLength(4);
		expect(result.skipped).toHaveLength(0);
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.enabledPlugins["linear@claude-plugins-official"]).toBe(true);
		expect(settings.enabledPlugins["notion@claude-plugins-official"]).toBe(true);
		expect(settings.enabledPlugins["slack@claude-plugins-official"]).toBe(true);
		expect(settings.enabledPlugins["claude-md-management@claude-plugins-official"]).toBe(true);
	});

	test("preserves an existing settings.json with unrelated fields", () => {
		writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ["Read"] }, model: "claude-opus-4-6" }));
		seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath);
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.permissions).toEqual({ allow: ["Read"] });
		expect(settings.model).toBe("claude-opus-4-6");
		expect(Object.keys(settings.enabledPlugins)).toHaveLength(4);
	});

	test("preserves operator-disabled picks (set to false)", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				enabledPlugins: {
					"linear@claude-plugins-official": false,
				},
			}),
		);
		const result = seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath);
		expect(result.added).not.toContain("linear@claude-plugins-official");
		expect(result.skipped).toContain("linear@claude-plugins-official");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.enabledPlugins["linear@claude-plugins-official"]).toBe(false);
		// Other picks still added
		expect(settings.enabledPlugins["notion@claude-plugins-official"]).toBe(true);
	});

	test("preserves operator-installed entries from other marketplaces", () => {
		writeFileSync(
			settingsPath,
			JSON.stringify({
				enabledPlugins: {
					"my-custom@my-marketplace": true,
				},
			}),
		);
		seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath);
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.enabledPlugins["my-custom@my-marketplace"]).toBe(true);
		expect(settings.enabledPlugins["notion@claude-plugins-official"]).toBe(true);
	});

	test("is idempotent: running twice does not double-add", () => {
		seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath);
		const second = seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath);
		expect(second.added).toEqual([]);
		expect(second.skipped).toHaveLength(4);
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(Object.keys(settings.enabledPlugins)).toHaveLength(4);
	});

	test("DEFAULT_PLUGIN_PICKS is exactly four", () => {
		expect(DEFAULT_PLUGIN_PICKS).toHaveLength(4);
		const names = DEFAULT_PLUGIN_PICKS.map((p) => p.plugin);
		expect(names).toContain("linear");
		expect(names).toContain("notion");
		expect(names).toContain("slack");
		expect(names).toContain("claude-md-management");
	});

	test("dryRun computes the would-add set without writing settings.json", () => {
		// File does not exist yet. Dry run should report would-add but never create.
		expect(existsSync(settingsPath)).toBe(false);
		const result = seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath, { dryRun: true });
		expect(result.added).toHaveLength(4);
		expect(result.skipped).toHaveLength(0);
		expect(existsSync(settingsPath)).toBe(false);
	});

	test("dryRun on an existing settings.json does not mutate the file", () => {
		const original = JSON.stringify({
			enabledPlugins: {
				"linear@claude-plugins-official": false,
				"my-custom@my-marketplace": true,
			},
			model: "claude-opus-4-6",
		});
		writeFileSync(settingsPath, original);
		const result = seedDefaultPlugins(DEFAULT_PLUGIN_PICKS, settingsPath, { dryRun: true });
		expect(result.added).toHaveLength(3); // notion, slack, claude-md-management
		expect(result.skipped).toContain("linear@claude-plugins-official");
		const onDisk = readFileSync(settingsPath, "utf-8");
		expect(onDisk).toBe(original); // byte-for-byte identical
	});
});
