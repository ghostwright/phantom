import { describe, expect, test } from "bun:test";
import { CuratedSettingsSchema, DENYLISTED_KEYS, WHITELISTED_KEYS } from "../schema.ts";

describe("CuratedSettingsSchema", () => {
	test("accepts an empty object", () => {
		expect(CuratedSettingsSchema.safeParse({}).success).toBe(true);
	});

	test("accepts a minimal permission set", () => {
		const r = CuratedSettingsSchema.safeParse({
			permissions: { allow: ["Bash(git:*)"], deny: [] },
		});
		expect(r.success).toBe(true);
	});

	test("accepts a full safe payload", () => {
		const r = CuratedSettingsSchema.safeParse({
			permissions: { allow: ["Bash(git:*)"], deny: ["Bash(rm:*)"], defaultMode: "default" },
			model: "claude-opus-4-6",
			effortLevel: "high",
			enabledMcpjsonServers: ["playwright"],
			autoMemoryEnabled: true,
			autoDreamEnabled: true,
			cleanupPeriodDays: 60,
			respectGitignore: true,
			defaultShell: "bash",
			allowedHttpHookUrls: ["https://hooks.example.com/*"],
			sandbox: {
				enabled: false,
				network: { allowedDomains: ["github.com"] },
			},
		});
		expect(r.success).toBe(true);
	});

	describe("deny-list enforcement via .strict()", () => {
		test("rejects apiKeyHelper", () => {
			const r = CuratedSettingsSchema.safeParse({ apiKeyHelper: "/usr/local/bin/helper.sh" });
			expect(r.success).toBe(false);
		});

		test("rejects modelOverrides", () => {
			const r = CuratedSettingsSchema.safeParse({ modelOverrides: { opus: "cheap-model" } });
			expect(r.success).toBe(false);
		});

		test("rejects availableModels", () => {
			const r = CuratedSettingsSchema.safeParse({ availableModels: ["opus", "sonnet"] });
			expect(r.success).toBe(false);
		});

		test("rejects hooks (owned by dedicated editor)", () => {
			const r = CuratedSettingsSchema.safeParse({
				hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "x" }] }] },
			});
			expect(r.success).toBe(false);
		});

		test("rejects enabledPlugins (owned by dedicated editor)", () => {
			const r = CuratedSettingsSchema.safeParse({ enabledPlugins: { "linear@claude-plugins-official": true } });
			expect(r.success).toBe(false);
		});

		test("rejects autoMemoryDirectory", () => {
			const r = CuratedSettingsSchema.safeParse({ autoMemoryDirectory: "/tmp/evil" });
			expect(r.success).toBe(false);
		});

		test("rejects extraKnownMarketplaces", () => {
			const r = CuratedSettingsSchema.safeParse({ extraKnownMarketplaces: {} });
			expect(r.success).toBe(false);
		});

		test("rejects fileSuggestion (command execution)", () => {
			const r = CuratedSettingsSchema.safeParse({ fileSuggestion: { type: "command", command: "echo" } });
			expect(r.success).toBe(false);
		});

		test("rejects forceLoginMethod", () => {
			const r = CuratedSettingsSchema.safeParse({ forceLoginMethod: "claudeai" });
			expect(r.success).toBe(false);
		});

		test("rejects otelHeadersHelper (script execution)", () => {
			const r = CuratedSettingsSchema.safeParse({ otelHeadersHelper: "/usr/local/bin/otel.sh" });
			expect(r.success).toBe(false);
		});
	});

	describe("whitelist coverage", () => {
		test("whitelist and deny-list have no overlap", () => {
			for (const k of DENYLISTED_KEYS) {
				expect(WHITELISTED_KEYS).not.toContain(k as unknown as (typeof WHITELISTED_KEYS)[number]);
			}
		});

		test("whitelist includes the safe permission fields", () => {
			expect(WHITELISTED_KEYS).toContain("permissions");
			expect(WHITELISTED_KEYS).toContain("model");
			expect(WHITELISTED_KEYS).toContain("allowedHttpHookUrls");
		});

		test("deny-list includes the dedicated-editor fields", () => {
			expect(DENYLISTED_KEYS).toContain("hooks");
			expect(DENYLISTED_KEYS).toContain("enabledPlugins");
		});
	});

	describe("bounded numerics", () => {
		test("feedbackSurveyRate rejects out of [0, 1]", () => {
			expect(CuratedSettingsSchema.safeParse({ feedbackSurveyRate: 1.5 }).success).toBe(false);
			expect(CuratedSettingsSchema.safeParse({ feedbackSurveyRate: -0.1 }).success).toBe(false);
			expect(CuratedSettingsSchema.safeParse({ feedbackSurveyRate: 0.5 }).success).toBe(true);
		});

		test("cleanupPeriodDays rejects negative", () => {
			expect(CuratedSettingsSchema.safeParse({ cleanupPeriodDays: -1 }).success).toBe(false);
			expect(CuratedSettingsSchema.safeParse({ cleanupPeriodDays: 0 }).success).toBe(true);
			expect(CuratedSettingsSchema.safeParse({ cleanupPeriodDays: 30 }).success).toBe(true);
		});
	});
});
