import { describe, expect, test } from "bun:test";
import {
	CuratedOverlaySchema,
	EnabledPluginsMapSchema,
	MarketplaceSchema,
	NormalizedPluginSchema,
	UpstreamPluginSchema,
	isEnabledValueActive,
	normalizeSource,
} from "../manifest.ts";

describe("UpstreamPluginSchema", () => {
	test("parses a minimal entry", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "notion",
			description: "Notion integration",
		});
		expect(parsed.name).toBe("notion");
	});

	test("parses a url-type source", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "notion",
			description: "x",
			source: { source: "url", url: "https://github.com/makenotion/claude-code-notion-plugin.git" },
			category: "productivity",
		});
		expect(parsed.source).toMatchObject({ source: "url" });
	});

	test("parses a local ./source", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "linear",
			description: "Linear",
			source: "./external_plugins/linear",
		});
		expect(parsed.source).toBe("./external_plugins/linear");
	});

	test("parses a git-subdir source", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "expo",
			description: "Expo skills",
			source: { source: "git-subdir", url: "expo/skills", path: "." },
		});
		expect((parsed.source as { source: string }).source).toBe("git-subdir");
	});

	test("reject missing name", () => {
		expect(() => UpstreamPluginSchema.parse({ description: "x" })).toThrow();
	});

	test("tolerates unknown fields", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "notion",
			description: "x",
			randomUpstreamField: 42,
		});
		expect(parsed.name).toBe("notion");
	});

	test("accepts lspServers as a record keyed by server name (real upstream shape)", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "clangd-lsp",
			description: "C/C++ language server",
			lspServers: {
				clangd: {
					command: "clangd",
					args: ["--background-index"],
					extensionToLanguage: { ".c": "c", ".cpp": "cpp" },
				},
			},
		});
		expect(parsed.name).toBe("clangd-lsp");
	});

	test("accepts lspServers as an object with multiple servers", () => {
		const parsed = UpstreamPluginSchema.parse({
			name: "polyglot-lsp",
			description: "many languages",
			lspServers: {
				clangd: { command: "clangd" },
				rust_analyzer: { command: "rust-analyzer" },
				gopls: { command: "gopls" },
			},
		});
		expect(parsed.name).toBe("polyglot-lsp");
	});
});

describe("MarketplaceSchema", () => {
	test("parses a tiny valid marketplace", () => {
		const parsed = MarketplaceSchema.parse({
			name: "claude-plugins-official",
			description: "Test",
			owner: { name: "Anthropic" },
			plugins: [
				{ name: "notion", description: "Notion" },
				{ name: "linear", description: "Linear", source: "./external_plugins/linear" },
			],
		});
		expect(parsed.plugins).toHaveLength(2);
	});

	test("requires plugins array", () => {
		expect(() => MarketplaceSchema.parse({ name: "x" })).toThrow();
	});
});

describe("CuratedOverlaySchema", () => {
	test("parses an empty overlay", () => {
		const parsed = CuratedOverlaySchema.parse({ version: 1, plugins: {} });
		expect(parsed.plugins).toEqual({});
	});

	test("parses a populated entry", () => {
		const parsed = CuratedOverlaySchema.parse({
			version: 1,
			plugins: {
				"notion@claude-plugins-official": {
					tags: ["phantom-recommended", "production-tested"],
					audience: ["founder", "pm"],
					note: "Phantom's default workspace plugin.",
					pinned_version: "1.2.3",
				},
			},
		});
		expect(parsed.plugins["notion@claude-plugins-official"].tags).toContain("phantom-recommended");
	});

	test("rejects invalid tag", () => {
		expect(() =>
			CuratedOverlaySchema.parse({
				version: 1,
				plugins: { "notion@claude-plugins-official": { tags: ["not-a-real-tag"] } },
			}),
		).toThrow();
	});

	test("rejects wrong version", () => {
		expect(() => CuratedOverlaySchema.parse({ version: 2, plugins: {} })).toThrow();
	});
});

describe("EnabledPluginsMapSchema", () => {
	test("accepts boolean, array, object values", () => {
		const parsed = EnabledPluginsMapSchema.parse({
			"a@b": true,
			"c@d": false,
			"e@f": ["^1.0.0"],
			"g@h": { pinned: "1.2.3" },
		});
		expect(parsed["a@b"]).toBe(true);
	});
});

describe("isEnabledValueActive", () => {
	test("handles all shapes", () => {
		expect(isEnabledValueActive(undefined)).toBe(false);
		expect(isEnabledValueActive(false)).toBe(false);
		expect(isEnabledValueActive(true)).toBe(true);
		expect(isEnabledValueActive([])).toBe(false);
		expect(isEnabledValueActive(["^1.0.0"])).toBe(true);
		expect(isEnabledValueActive({})).toBe(false);
		expect(isEnabledValueActive({ pinned: "1.2.3" })).toBe(true);
	});
});

describe("normalizeSource", () => {
	test("url object", () => {
		const n = normalizeSource({ source: "url", url: "https://github.com/x/y.git" });
		expect(n).toEqual({ source_type: "url", source_url: "https://github.com/x/y.git" });
	});

	test("string local path", () => {
		const n = normalizeSource("./plugins/foo");
		expect(n).toEqual({ source_type: "local", source_url: "./plugins/foo" });
	});

	test("undefined source falls back to local", () => {
		const n = normalizeSource(undefined);
		expect(n).toEqual({ source_type: "local", source_url: null });
	});

	test("git-subdir source", () => {
		const n = normalizeSource({ source: "git-subdir", url: "expo/skills", path: "." });
		expect(n.source_type).toBe("git-subdir");
	});
});

describe("NormalizedPluginSchema", () => {
	test("parses a realistic normalized entry", () => {
		const parsed = NormalizedPluginSchema.parse({
			name: "notion",
			marketplace: "claude-plugins-official",
			description: "Notion workspace integration.",
			source_type: "url",
			source_url: "https://github.com/makenotion/claude-code-notion-plugin.git",
			category: "productivity",
			homepage: null,
			version: null,
			tags: [],
			curated_tags: [],
			curated_note: null,
			audience: [],
			pinned_version: null,
			enabled: true,
		});
		expect(parsed.enabled).toBe(true);
	});
});
