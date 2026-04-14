import { describe, expect, test } from "bun:test";
import { parseFrontmatter, serializeSubagent } from "../frontmatter.ts";

describe("parseFrontmatter", () => {
	test("parses a minimal valid subagent", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper and summarize it in five bullets.\n---\n\n# Research intern\n\nBody goes here.\n",
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.frontmatter.name).toBe("research-intern");
		expect(result.parsed.frontmatter.description).toContain("Fetch a paper");
		expect(result.parsed.body).toContain("Body goes here");
	});

	test("parses the full field set", () => {
		const result = parseFrontmatter(
			[
				"---",
				"name: qa-checker",
				"description: Verify that unit tests ran and passed on the latest changes.",
				"tools:",
				"  - Bash",
				"  - Read",
				"model: sonnet",
				"effort: medium",
				"color: blue",
				"memory: remembers what tests flake",
				"---",
				"",
				"# QA checker",
				"",
				"Check the test suite.",
				"",
			].join("\n"),
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.frontmatter.tools).toEqual(["Bash", "Read"]);
		expect(result.parsed.frontmatter.model).toBe("sonnet");
		expect(result.parsed.frontmatter.effort).toBe("medium");
		expect(result.parsed.frontmatter.color).toBe("blue");
	});

	test("rejects missing opening ---", () => {
		const result = parseFrontmatter("name: research-intern\ndescription: x\n");
		expect(result.ok).toBe(false);
	});

	test("rejects unterminated frontmatter", () => {
		const result = parseFrontmatter("---\nname: research-intern\ndescription: x\n\n# no closing");
		expect(result.ok).toBe(false);
	});

	test("rejects missing required field (description)", () => {
		const result = parseFrontmatter("---\nname: research-intern\n---\n\n# Body\n");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("description");
	});

	test("rejects unknown fields via strict mode", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\nzzz_unknown: true\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("rejects invalid color", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\ncolor: teal\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("rejects invalid effort", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\neffort: maximum\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("rejects name with capital letters", () => {
		const result = parseFrontmatter("---\nname: Research-Intern\ndescription: x y z\n---\n\n# Body\n");
		expect(result.ok).toBe(false);
	});
});

describe("serializeSubagent", () => {
	test("round-trips a minimal subagent", () => {
		const original = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper and summarize.\n---\n\n# Body\n",
		);
		expect(original.ok).toBe(true);
		if (!original.ok) return;
		const out = serializeSubagent(original.parsed.frontmatter, original.parsed.body);
		const re = parseFrontmatter(out);
		expect(re.ok).toBe(true);
		if (!re.ok) return;
		expect(re.parsed.frontmatter.name).toBe("research-intern");
		expect(re.parsed.frontmatter.description).toBe("Fetch a paper and summarize.");
		expect(re.parsed.body).toContain("# Body");
	});

	test("serializes with expected field order (cli.js parity)", () => {
		const out = serializeSubagent(
			{
				name: "qa-checker",
				description: "Verify tests ran.",
				tools: ["Bash"],
				model: "sonnet",
				effort: "medium",
				color: "blue",
				memory: "remembers flakes",
			},
			"# QA checker\n\nCheck the tests.\n",
		);
		// name comes before description, which comes before tools, etc.
		const nameIdx = out.indexOf("name:");
		const descIdx = out.indexOf("description:");
		const toolsIdx = out.indexOf("tools:");
		const modelIdx = out.indexOf("model:");
		const effortIdx = out.indexOf("effort:");
		const colorIdx = out.indexOf("color:");
		expect(nameIdx).toBeLessThan(descIdx);
		expect(descIdx).toBeLessThan(toolsIdx);
		expect(toolsIdx).toBeLessThan(modelIdx);
		expect(modelIdx).toBeLessThan(effortIdx);
		expect(effortIdx).toBeLessThan(colorIdx);
	});
});
