import { describe, expect, test } from "bun:test";
import type { EvolvedConfig } from "../../../evolution/types.ts";
import { buildEvolvedSections } from "../evolved.ts";

function makeConfig(overrides: Partial<EvolvedConfig> = {}): EvolvedConfig {
	return {
		constitution: "",
		persona: "",
		userProfile: "",
		domainKnowledge: "",
		strategies: {
			taskPatterns: "",
			toolPreferences: "",
			errorRecovery: "",
		},
		meta: {
			version: 1,
			metricsSnapshot: {
				session_count: 0,
				success_rate_7d: 0,
			},
		},
		...overrides,
	};
}

describe("buildEvolvedSections", () => {
	test("returns empty string when all fields are empty", () => {
		const result = buildEvolvedSections(makeConfig());
		expect(result).toBe("");
	});

	test("returns empty string when all fields are whitespace-only", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "   ",
				persona: "  \n  ",
				userProfile: "\t",
			}),
		);
		expect(result).toBe("");
	});

	test("includes constitution section when populated", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Always be helpful.\nNever lie.",
			}),
		);
		expect(result).toContain("# Constitution");
		expect(result).toContain("Always be helpful.");
		expect(result).toContain("Never lie.");
	});

	test("includes persona section when it has multiple content lines", () => {
		const result = buildEvolvedSections(
			makeConfig({
				persona: "Be concise.\nUse technical language.\nAvoid jargon.",
			}),
		);
		expect(result).toContain("# Communication Style");
		expect(result).toContain("Be concise.");
	});

	test("skips persona when it has only one content line", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Rule one.\nRule two.",
				persona: "Be friendly.",
			}),
		);
		expect(result).not.toContain("# Communication Style");
	});

	test("includes userProfile section when it has multiple content lines", () => {
		const result = buildEvolvedSections(
			makeConfig({
				userProfile: "Senior engineer.\nPrefers TypeScript.\nUses Vim.",
			}),
		);
		expect(result).toContain("# User Profile");
		expect(result).toContain("Senior engineer.");
	});

	test("skips userProfile when it has only one content line", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Be honest.\nBe helpful.",
				userProfile: "Developer.",
			}),
		);
		expect(result).not.toContain("# User Profile");
	});

	test("includes domainKnowledge when it has multiple content lines", () => {
		const result = buildEvolvedSections(
			makeConfig({
				domainKnowledge: "Uses PostgreSQL.\nRuns on Kubernetes.\nHosts on AWS.",
			}),
		);
		expect(result).toContain("# Domain Knowledge");
		expect(result).toContain("Uses PostgreSQL.");
	});

	test("skips domainKnowledge with only one content line", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Help.\nAlways.",
				domainKnowledge: "Uses React.",
			}),
		);
		expect(result).not.toContain("# Domain Knowledge");
	});

	test("includes learned strategies when subsections have multiple content lines", () => {
		const result = buildEvolvedSections(
			makeConfig({
				strategies: {
					taskPatterns: "Break into small steps.\nVerify each step.",
					toolPreferences: "Prefer grep over find.\nUse ripgrep for speed.",
					errorRecovery: "Retry once.\nLog the error.",
				},
			}),
		);
		expect(result).toContain("# Learned Strategies");
		expect(result).toContain("Break into small steps.");
		expect(result).toContain("Prefer grep over find.");
		expect(result).toContain("Retry once.");
	});

	test("includes strategy section when only some subsections qualify", () => {
		const result = buildEvolvedSections(
			makeConfig({
				strategies: {
					taskPatterns: "Break into steps.\nVerify.",
					toolPreferences: "One liner only.",
					errorRecovery: "",
				},
			}),
		);
		expect(result).toContain("# Learned Strategies");
		expect(result).toContain("Break into steps.");
		expect(result).not.toContain("One liner only.");
	});

	test("omits strategy section when no subsections qualify", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Be good.\nBe great.",
				strategies: {
					taskPatterns: "Single line.",
					toolPreferences: "",
					errorRecovery: "",
				},
			}),
		);
		expect(result).not.toContain("# Learned Strategies");
	});

	test("combines multiple sections with double newlines", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Always help.\nNever harm.",
				persona: "Be terse.\nBe direct.\nNo fluff.",
			}),
		);
		expect(result).toContain("# Constitution\n\nAlways help.\nNever harm.");
		expect(result).toContain("# Communication Style\n\nBe terse.\nBe direct.\nNo fluff.");
		expect(result.indexOf("# Constitution")).toBeLessThan(result.indexOf("# Communication Style"));
	});

	test("heading-only lines are not counted as content", () => {
		const result = buildEvolvedSections(
			makeConfig({
				constitution: "Be good.\nStay honest.",
				persona: "# Style Guide\nBe concise.",
			}),
		);
		// "# Style Guide" is a heading, "Be concise." is the only content line
		expect(result).not.toContain("# Communication Style");
	});
});
