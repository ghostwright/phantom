import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	OFFICIAL_MARKETPLACE_ID,
	formatPluginKey,
	getClaudeRoot,
	getPluginCacheRoot,
	getUserSettingsPath,
	isValidMarketplaceId,
	isValidPluginId,
	parsePluginKey,
} from "../paths.ts";

const priorOverride = process.env.PHANTOM_CLAUDE_ROOT;

afterEach(() => {
	if (priorOverride !== undefined) {
		process.env.PHANTOM_CLAUDE_ROOT = priorOverride;
	} else {
		Reflect.deleteProperty(process.env, "PHANTOM_CLAUDE_ROOT");
	}
});

describe("isValidPluginId", () => {
	test("accepts standard plugin ids", () => {
		expect(isValidPluginId("notion")).toBe(true);
		expect(isValidPluginId("claude-md-management")).toBe(true);
		expect(isValidPluginId("pr-review-toolkit")).toBe(true);
		expect(isValidPluginId("a1-b2-c3")).toBe(true);
	});

	test("rejects empty, uppercase, spaces, slashes, traversal", () => {
		expect(isValidPluginId("")).toBe(false);
		expect(isValidPluginId("Notion")).toBe(false);
		expect(isValidPluginId("my plugin")).toBe(false);
		expect(isValidPluginId("folder/name")).toBe(false);
		expect(isValidPluginId("../etc/passwd")).toBe(false);
	});

	test("rejects null bytes", () => {
		expect(isValidPluginId("notion\0evil")).toBe(false);
	});

	test("caps length at 64", () => {
		expect(isValidPluginId("a".repeat(64))).toBe(true);
		expect(isValidPluginId("a".repeat(65))).toBe(false);
	});
});

describe("isValidMarketplaceId", () => {
	test("accepts the canonical marketplace id", () => {
		expect(isValidMarketplaceId(OFFICIAL_MARKETPLACE_ID)).toBe(true);
		expect(isValidMarketplaceId("claude-plugins-official")).toBe(true);
	});

	test("rejects empty and invalid", () => {
		expect(isValidMarketplaceId("")).toBe(false);
		expect(isValidMarketplaceId("Claude-Plugins")).toBe(false);
	});
});

describe("parsePluginKey", () => {
	test("parses canonical key", () => {
		const parsed = parsePluginKey("notion@claude-plugins-official");
		expect(parsed).toEqual({ plugin: "notion", marketplace: "claude-plugins-official" });
	});

	test("rejects missing parts", () => {
		expect(parsePluginKey("notion")).toBeNull();
		expect(parsePluginKey("@claude-plugins-official")).toBeNull();
		expect(parsePluginKey("notion@")).toBeNull();
		expect(parsePluginKey("")).toBeNull();
	});

	test("rejects invalid halves", () => {
		expect(parsePluginKey("Notion@claude-plugins-official")).toBeNull();
		expect(parsePluginKey("notion@Claude-Plugins")).toBeNull();
		expect(parsePluginKey("../x@y")).toBeNull();
	});

	test("handles plugin ids with dots and underscores", () => {
		const parsed = parsePluginKey("my_plugin.v2@claude-plugins-official");
		expect(parsed).toEqual({ plugin: "my_plugin.v2", marketplace: "claude-plugins-official" });
	});
});

describe("formatPluginKey", () => {
	test("builds the canonical string", () => {
		expect(formatPluginKey("notion", "claude-plugins-official")).toBe("notion@claude-plugins-official");
	});

	test("throws on invalid id", () => {
		expect(() => formatPluginKey("", "claude-plugins-official")).toThrow();
		expect(() => formatPluginKey("Notion", "claude-plugins-official")).toThrow();
		expect(() => formatPluginKey("notion", "Invalid Marketplace")).toThrow();
	});
});

describe("getClaudeRoot + getUserSettingsPath + getPluginCacheRoot", () => {
	test("honors PHANTOM_CLAUDE_ROOT override", () => {
		const tmp = mkdtempSync(join(tmpdir(), "phantom-plugins-"));
		try {
			process.env.PHANTOM_CLAUDE_ROOT = tmp;
			expect(getClaudeRoot()).toBe(tmp);
			expect(getUserSettingsPath()).toBe(join(tmp, "settings.json"));
			expect(getPluginCacheRoot()).toBe(join(tmp, "plugins"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});
