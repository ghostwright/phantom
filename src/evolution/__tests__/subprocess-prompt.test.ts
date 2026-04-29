import { describe, expect, test } from "bun:test";
import { REFLECTION_SUBPROCESS_PROMPT, buildSubprocessSystemPrompt } from "../subprocess-prompt.ts";

// Phase 3 subprocess prompt tests. The prompt is the single highest-leverage
// artifact in the rewrite. These tests pin the structural contract so a
// well-meaning edit cannot silently drop a load-bearing section.

describe("REFLECTION_SUBPROCESS_PROMPT", () => {
	test("opens with the Cardinal Rule framing", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT.startsWith("You are Phantom's reflection subprocess")).toBe(true);
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("You are trusted.");
	});

	test("names every canonical memory file", () => {
		const canonicalFiles = [
			"persona.md",
			"user-profile.md",
			"domain-knowledge.md",
			"strategies/task-patterns.md",
			"strategies/tool-preferences.md",
			"strategies/error-recovery.md",
			"memory/corrections.md",
			"memory/principles.md",
			"constitution.md",
		];
		for (const file of canonicalFiles) {
			expect(REFLECTION_SUBPROCESS_PROMPT).toContain(file);
		}
	});

	test("declares constitution immutability clearly", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("IMMUTABLE");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Never write to constitution.md");
	});

	test("names the three tiers so the agent knows its capacity", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Haiku");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Sonnet");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Opus");
	});

	test("repeats the skip default three times in different framings", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("default outcome is skip");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Skip is the correct answer");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("default answer is skip");
	});

	test("teaches the sentinel shapes", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain(`"status":"ok"`);
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain(`"status":"skip"`);
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain(`"status":"escalate"`);
	});

	test("teaches the promotion rule (fix for the 100% user-profile appends pathology)", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("promote between files");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Before defaulting to user-profile");
	});

	test("warns against credential patterns (I6 hard tier education)", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("credentials");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("sk-ant-");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("ANTHROPIC_API_KEY");
	});

	test("includes at least one worked good/bad bullet example", () => {
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Bad:");
		expect(REFLECTION_SUBPROCESS_PROMPT).toContain("Good:");
	});
});

describe("buildSubprocessSystemPrompt", () => {
	test("prepends a runtime header with batch and tier facts", () => {
		const result = buildSubprocessSystemPrompt(REFLECTION_SUBPROCESS_PROMPT, {
			drainId: "batch-abc",
			batchSessions: 5,
			currentVersion: 42,
			tier: "haiku",
			fileSizesLines: { "user-profile.md": 56 },
		});
		expect(result).toContain("Batch id: batch-abc");
		expect(result).toContain("Batch sessions: 5");
		expect(result).toContain("Current version: v42");
		expect(result).toContain("You are running at: haiku");
		expect(result).toContain("user-profile.md: 56");
	});

	test("appends the teaching prompt verbatim below the header", () => {
		const result = buildSubprocessSystemPrompt("BODY", {
			drainId: "d",
			batchSessions: 1,
			currentVersion: 0,
			tier: "sonnet",
			fileSizesLines: {},
		});
		expect(result.endsWith("\nBODY")).toBe(true);
	});

	test("sorts file sizes alphabetically for stable output", () => {
		const result = buildSubprocessSystemPrompt("_", {
			drainId: "d",
			batchSessions: 0,
			currentVersion: 0,
			tier: "opus",
			fileSizesLines: { "zebra.md": 1, "alpha.md": 2 },
		});
		expect(result.indexOf("alpha.md")).toBeLessThan(result.indexOf("zebra.md"));
	});

	test("renders an empty file-sizes map as (none)", () => {
		const result = buildSubprocessSystemPrompt("_", {
			drainId: "d",
			batchSessions: 0,
			currentVersion: 0,
			tier: "haiku",
			fileSizesLines: {},
		});
		expect(result).toContain("(none)");
	});
});
