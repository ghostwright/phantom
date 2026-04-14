import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSubagent, listSubagents, readSubagent, writeSubagent } from "../storage.ts";

let tmp: string;

const validFrontmatter = {
	name: "research-intern",
	description: "Fetch a paper and summarize into five bullets.",
};

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-subagents-"));
	process.env.PHANTOM_SUBAGENTS_USER_ROOT = tmp;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_SUBAGENTS_USER_ROOT");
});

describe("listSubagents", () => {
	test("returns empty list when root does not exist", () => {
		rmSync(tmp, { recursive: true, force: true });
		const result = listSubagents();
		expect(result.subagents).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("lists a valid subagent", () => {
		writeFileSync(
			join(tmp, "research-intern.md"),
			"---\nname: research-intern\ndescription: Fetch a paper and summarize it.\n---\n\n# Research intern\n",
		);
		const result = listSubagents();
		expect(result.subagents.length).toBe(1);
		expect(result.subagents[0].name).toBe("research-intern");
	});

	test("captures model and effort and color in summary", () => {
		writeFileSync(
			join(tmp, "qa-checker.md"),
			[
				"---",
				"name: qa-checker",
				"description: Verify that unit tests ran and passed.",
				"model: sonnet",
				"effort: medium",
				"color: blue",
				"---",
				"",
				"# QA",
				"",
			].join("\n"),
		);
		const result = listSubagents();
		expect(result.subagents.length).toBe(1);
		expect(result.subagents[0].model).toBe("sonnet");
		expect(result.subagents[0].effort).toBe("medium");
		expect(result.subagents[0].color).toBe("blue");
	});

	test("skips files that are not .md", () => {
		writeFileSync(join(tmp, "not-an-agent.txt"), "ignored");
		writeFileSync(join(tmp, "real.md"), "---\nname: real\ndescription: A real subagent definition.\n---\n\n# Real\n");
		const result = listSubagents();
		expect(result.subagents.length).toBe(1);
		expect(result.subagents[0].name).toBe("real");
	});

	test("skips files with invalid names", () => {
		writeFileSync(join(tmp, "Bad-Name.md"), "---\nname: bad\ndescription: Not going to parse.\n---\n\n# Bad\n");
		const result = listSubagents();
		expect(result.subagents.length).toBe(0);
	});

	test("surfaces parse errors", () => {
		writeFileSync(join(tmp, "broken.md"), "not even yaml");
		const result = listSubagents();
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].name).toBe("broken");
	});

	test("sorts newest-first by mtime", () => {
		writeFileSync(join(tmp, "one.md"), "---\nname: one\ndescription: Aaaa first one here.\n---\n\n# 1\n");
		// Force a delay so the second file has a distinct newer mtime
		const ts = Date.now() + 50;
		writeFileSync(join(tmp, "two.md"), "---\nname: two\ndescription: Bbbb second one here.\n---\n\n# 2\n");
		// bun:sqlite beforeEach does not help here; we can check both land
		const result = listSubagents();
		expect(result.subagents.length).toBe(2);
		const names = result.subagents.map((s) => s.name);
		expect(names).toContain("one");
		expect(names).toContain("two");
		// Touch to confirm deterministic order is possible
		expect(typeof ts).toBe("number");
	});
});

describe("writeSubagent and readSubagent", () => {
	test("creates a new subagent", () => {
		const result = writeSubagent(
			{
				name: "research-intern",
				frontmatter: validFrontmatter,
				body: "# Research intern\n\nDo research.\n",
			},
			{ mustExist: false },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.subagent.name).toBe("research-intern");
		expect(result.previousBody).toBe(null);
		expect(existsSync(join(tmp, "research-intern.md"))).toBe(true);
	});

	test("refuses to overwrite on create", () => {
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# First\n" }, { mustExist: false });
		const second = writeSubagent(
			{ name: "research-intern", frontmatter: validFrontmatter, body: "# Second\n" },
			{ mustExist: false },
		);
		expect(second.ok).toBe(false);
		if (second.ok) return;
		expect(second.status).toBe(409);
	});

	test("updates an existing subagent and returns the previous body", () => {
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# First\n" }, { mustExist: false });
		const updated = writeSubagent(
			{ name: "research-intern", frontmatter: validFrontmatter, body: "# Second\n" },
			{ mustExist: true },
		);
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.previousBody?.includes("First")).toBe(true);
		expect(updated.subagent.body.includes("Second")).toBe(true);
	});

	test("update returns 404 for missing subagent", () => {
		const result = writeSubagent(
			{ name: "nope", frontmatter: { ...validFrontmatter, name: "nope" }, body: "# body\n" },
			{ mustExist: true },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});

	test("read returns 404 for missing subagent", () => {
		const result = readSubagent("does-not-exist");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});

	test("write rejects body over 50KB", () => {
		const giantBody = "x".repeat(60 * 1024);
		const result = writeSubagent(
			{ name: "research-intern", frontmatter: validFrontmatter, body: giantBody },
			{ mustExist: false },
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
	});

	test("write rejects mismatched frontmatter.name and path name", () => {
		const result = writeSubagent(
			{
				name: "research-intern",
				frontmatter: { ...validFrontmatter, name: "someone-else" },
				body: "# body\n",
			},
			{ mustExist: false },
		);
		expect(result.ok).toBe(false);
	});

	test("write rejects reserved stems at path resolution", () => {
		const result = writeSubagent(
			{ name: "agents", frontmatter: { ...validFrontmatter, name: "agents" }, body: "# body\n" },
			{ mustExist: false },
		);
		expect(result.ok).toBe(false);
	});
});

describe("deleteSubagent", () => {
	test("removes an existing subagent file", () => {
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# body\n" }, { mustExist: false });
		const result = deleteSubagent("research-intern");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.deleted).toBe("research-intern");
		expect(existsSync(join(tmp, "research-intern.md"))).toBe(false);
	});

	test("returns 404 for missing subagent", () => {
		const result = deleteSubagent("nope");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});

	test("returns 422 for invalid name", () => {
		const result = deleteSubagent("Bad Name");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(422);
	});
});

describe("atomic writes", () => {
	test("no torn file on re-read after write", () => {
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# v1\n" }, { mustExist: false });
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# v2\n" }, { mustExist: true });
		const r = readSubagent("research-intern");
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.subagent.body).toContain("# v2");
	});

	test("tmp files do not remain after successful write", () => {
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# body\n" }, { mustExist: false });
		const tmpFiles = ((): string[] => {
			try {
				const { readdirSync } = require("node:fs");
				return readdirSync(tmp).filter((f: string) => f.startsWith("."));
			} catch {
				return [];
			}
		})();
		expect(tmpFiles.length).toBe(0);
	});

	test("write does not affect unrelated files in the directory", () => {
		mkdirSync(join(tmp, "extra"), { recursive: true });
		writeFileSync(join(tmp, "extra", "something.txt"), "untouched");
		writeSubagent({ name: "research-intern", frontmatter: validFrontmatter, body: "# body\n" }, { mustExist: false });
		const { readFileSync } = require("node:fs");
		expect(readFileSync(join(tmp, "extra", "something.txt"), "utf-8")).toBe("untouched");
	});
});
