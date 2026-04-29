import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteSkill, listSkills, readSkill, writeSkill } from "../storage.ts";

let tmp: string;

const validSkill = {
	name: "mirror",
	description: "weekly self-audit",
	when_to_use: "Use when the user asks for a mirror on Fridays.",
};

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-skills-"));
	process.env.PHANTOM_SKILLS_USER_ROOT = tmp;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_SKILLS_USER_ROOT");
});

describe("listSkills", () => {
	test("returns empty list when root does not exist", () => {
		rmSync(tmp, { recursive: true, force: true });
		const result = listSkills();
		expect(result.skills).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	test("lists a valid skill", () => {
		const skillDir = join(tmp, "mirror");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: mirror\ndescription: weekly\nwhen_to_use: Use on Friday.\n---\n\n# Mirror\n",
		);
		const result = listSkills();
		expect(result.skills.length).toBe(1);
		expect(result.skills[0].name).toBe("mirror");
		expect(result.skills[0].source).toBe("user");
	});

	test("classifies a skill with x-phantom-source: built-in as built-in", () => {
		const skillDir = join(tmp, "mirror");
		mkdirSync(skillDir);
		writeFileSync(
			join(skillDir, "SKILL.md"),
			"---\nname: mirror\nx-phantom-source: built-in\ndescription: weekly\nwhen_to_use: Use on Friday.\n---\n\n# Mirror\n",
		);
		const result = listSkills();
		expect(result.skills.length).toBe(1);
		expect(result.skills[0].source).toBe("built-in");
	});

	test("skips directories with bad names", () => {
		const skillDir = join(tmp, "BAD NAME");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: bad\ndescription: x\nwhen_to_use: Use now.\n---\n\n# B\n");
		const result = listSkills();
		expect(result.skills.length).toBe(0);
	});

	test("surfaces parse errors", () => {
		const skillDir = join(tmp, "broken");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "not valid yaml at all");
		const result = listSkills();
		expect(result.errors.length).toBe(1);
		expect(result.errors[0].name).toBe("broken");
	});
});

describe("writeSkill and readSkill", () => {
	test("creates a new skill", () => {
		const result = writeSkill(
			{ name: "mirror", frontmatter: validSkill, body: "# Mirror\n\n## Goal\n\nDo it.\n" },
			{ mustExist: false },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.skill.name).toBe("mirror");
		expect(result.previousBody).toBe(null);
		expect(existsSync(join(tmp, "mirror", "SKILL.md"))).toBe(true);
	});

	test("refuses to overwrite on create", () => {
		writeSkill({ name: "mirror", frontmatter: validSkill, body: "# Mirror\n" }, { mustExist: false });
		const second = writeSkill({ name: "mirror", frontmatter: validSkill, body: "# Again\n" }, { mustExist: false });
		expect(second.ok).toBe(false);
	});

	test("updates an existing skill and returns the previous body", () => {
		writeSkill({ name: "mirror", frontmatter: validSkill, body: "# First\n" }, { mustExist: false });
		const updated = writeSkill({ name: "mirror", frontmatter: validSkill, body: "# Second\n" }, { mustExist: true });
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.previousBody?.includes("First")).toBe(true);
		expect(updated.skill.body.includes("Second")).toBe(true);
	});

	test("read returns 404 for missing skill", () => {
		const result = readSkill("does-not-exist");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});

	test("write rejects body over 50KB", () => {
		const giantBody = "x".repeat(60 * 1024);
		const result = writeSkill({ name: "mirror", frontmatter: validSkill, body: giantBody }, { mustExist: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
	});

	test("write rejects mismatched frontmatter.name and path name", () => {
		const result = writeSkill(
			{ name: "mirror", frontmatter: { ...validSkill, name: "thread" }, body: "# Body\n" },
			{ mustExist: false },
		);
		expect(result.ok).toBe(false);
	});
});

describe("deleteSkill", () => {
	test("removes an existing skill", () => {
		writeSkill({ name: "mirror", frontmatter: validSkill, body: "# Mirror\n" }, { mustExist: false });
		const result = deleteSkill("mirror");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.deleted).toBe("mirror");
		expect(existsSync(join(tmp, "mirror", "SKILL.md"))).toBe(false);
	});

	test("returns 404 for missing skill", () => {
		const result = deleteSkill("nope");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});
});
