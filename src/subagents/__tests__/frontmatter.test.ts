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

	test("parses the full field set including CLI-only camelCase keys", () => {
		const result = parseFrontmatter(
			[
				"---",
				"name: qa-checker",
				"description: Verify that unit tests ran and passed on the latest changes.",
				"tools:",
				"  - Bash",
				"  - Read",
				"disallowedTools:",
				"  - WebFetch",
				"model: sonnet",
				"effort: medium",
				"color: blue",
				"memory: project",
				"maxTurns: 15",
				"initialPrompt: Start by running bun test.",
				"skills:",
				"  - grep",
				"mcpServers:",
				"  - github",
				"background: false",
				"isolation: worktree",
				"permissionMode: acceptEdits",
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
		expect(result.parsed.frontmatter.disallowedTools).toEqual(["WebFetch"]);
		expect(result.parsed.frontmatter.model).toBe("sonnet");
		expect(result.parsed.frontmatter.effort).toBe("medium");
		expect(result.parsed.frontmatter.color).toBe("blue");
		expect(result.parsed.frontmatter.memory).toBe("project");
		expect(result.parsed.frontmatter.maxTurns).toBe(15);
		expect(result.parsed.frontmatter.initialPrompt).toContain("bun test");
		expect(result.parsed.frontmatter.skills).toEqual(["grep"]);
		expect(result.parsed.frontmatter.mcpServers).toEqual(["github"]);
		expect(result.parsed.frontmatter.background).toBe(false);
		expect(result.parsed.frontmatter.isolation).toBe("worktree");
		expect(result.parsed.frontmatter.permissionMode).toBe("acceptEdits");
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

	test("passthrough preserves unknown forward-compat fields on a round trip", () => {
		// The schema uses .passthrough() so any forward-compat SDK field
		// the CLI adds later survives a read. The dashboard renders only
		// the known fields and the serialize step re-emits the passthrough
		// fields at the end so nothing is silently dropped.
		const input = "---\nname: research-intern\ndescription: Fetch a paper.\nzzz_future: true\n---\n\n# Body\n";
		const result = parseFrontmatter(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const fm = result.parsed.frontmatter as Record<string, unknown>;
		expect(fm.zzz_future).toBe(true);
		const serialized = serializeSubagent(result.parsed.frontmatter, result.parsed.body);
		expect(serialized).toContain("zzz_future");
	});

	test("rejects unknown memory values outside the CLI enum", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\nmemory: remembers-things\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("rejects invalid permissionMode", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\npermissionMode: yolo\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("rejects tool name with HTML metacharacters for defense in depth", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\ntools:\n  - <script>alert(1)</script>\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("rejects tool name with shell metacharacters", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\ntools:\n  - ;rm -rf /\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(false);
	});

	test("accepts mcp__server__tool style tool names", () => {
		const result = parseFrontmatter(
			"---\nname: research-intern\ndescription: Fetch a paper.\ntools:\n  - mcp__github__create_issue\n---\n\n# Body\n",
		);
		expect(result.ok).toBe(true);
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
				memory: "project",
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

	test("accepts a CLI-authored agent file with skills and mcpServers", () => {
		// Simulates a subagent file authored by the CLI's own agent wizard
		// or hand-copied from Anthropic docs. Before the fix, .strict()
		// rejected this entire file; the dashboard surfaced it as a parse
		// error toast and the operator could not edit it through Phantom.
		const cliAuthored = [
			"---",
			"name: cli-authored",
			"description: A subagent the CLI wrote.",
			"tools:",
			"  - Read",
			"  - Grep",
			"skills:",
			"  - grep",
			"  - show-my-tools",
			"mcpServers:",
			"  - github",
			"  - linear",
			"background: true",
			"isolation: worktree",
			"permissionMode: bypassPermissions",
			"maxTurns: 50",
			"initialPrompt: Do the thing.",
			"memory: project",
			"---",
			"",
			"# CLI authored",
			"",
		].join("\n");
		const result = parseFrontmatter(cliAuthored);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const fm = result.parsed.frontmatter;
		expect(fm.skills).toEqual(["grep", "show-my-tools"]);
		expect(fm.mcpServers).toEqual(["github", "linear"]);
		expect(fm.background).toBe(true);
		expect(fm.isolation).toBe("worktree");
		expect(fm.permissionMode).toBe("bypassPermissions");
		expect(fm.maxTurns).toBe(50);
		expect(fm.memory).toBe("project");
	});

	test("round-trips the full CLI-shaped field set", () => {
		const fm = {
			name: "qa-checker",
			description: "Verify tests ran.",
			tools: ["Bash", "Read"],
			disallowedTools: ["WebFetch"],
			model: "sonnet",
			effort: "medium" as const,
			color: "blue" as const,
			memory: "project" as const,
			maxTurns: 10,
			initialPrompt: "Start by running bun test.",
			skills: ["grep"],
			mcpServers: ["github"],
			background: false,
			isolation: "worktree" as const,
			permissionMode: "acceptEdits" as const,
		};
		const out = serializeSubagent(fm, "# Body\n");
		const re = parseFrontmatter(out);
		expect(re.ok).toBe(true);
		if (!re.ok) return;
		expect(re.parsed.frontmatter).toMatchObject(fm);
	});
});
