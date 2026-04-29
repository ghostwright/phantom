import { describe, expect, test } from "bun:test";
import { agentNameInitial, capitalizeAgentName } from "../name.ts";

describe("capitalizeAgentName", () => {
	test("lowercase simple name", () => {
		expect(capitalizeAgentName("cheeks")).toBe("Cheeks");
	});

	test("lowercase second name", () => {
		expect(capitalizeAgentName("wehshi")).toBe("Wehshi");
	});

	test("already capitalized stays the same", () => {
		expect(capitalizeAgentName("Cody")).toBe("Cody");
	});

	test("empty string falls back to Phantom", () => {
		expect(capitalizeAgentName("")).toBe("Phantom");
	});

	test("whitespace-only falls back to Phantom", () => {
		expect(capitalizeAgentName("   ")).toBe("Phantom");
	});

	test("dashed multi-word title-cases each part", () => {
		expect(capitalizeAgentName("ai-coworker")).toBe("Ai-Coworker");
	});

	test("underscored multi-word preserves underscore separator", () => {
		expect(capitalizeAgentName("phantom_helper")).toBe("Phantom_Helper");
	});

	test("fully uppercase input gets normalized", () => {
		expect(capitalizeAgentName("TEAM-LEAD")).toBe("Team-Lead");
	});

	test("single character is upper-cased", () => {
		expect(capitalizeAgentName("x")).toBe("X");
	});

	test("mixed case normalizes", () => {
		expect(capitalizeAgentName("pHANTOM")).toBe("Phantom");
	});
});

describe("agentNameInitial", () => {
	test("returns first letter capitalized", () => {
		expect(agentNameInitial("Cheeks")).toBe("C");
	});

	test("returns P for empty input", () => {
		expect(agentNameInitial("")).toBe("P");
	});

	test("upper-cases lowercase first letter", () => {
		expect(agentNameInitial("wehshi")).toBe("W");
	});
});
