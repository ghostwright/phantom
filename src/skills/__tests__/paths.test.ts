import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserSkillsRoot, isValidSkillName, resolveUserSkillPath } from "../paths.ts";

const priorOverride = process.env.PHANTOM_SKILLS_USER_ROOT;

afterEach(() => {
	if (priorOverride !== undefined) {
		process.env.PHANTOM_SKILLS_USER_ROOT = priorOverride;
	} else {
		Reflect.deleteProperty(process.env, "PHANTOM_SKILLS_USER_ROOT");
	}
});

describe("isValidSkillName", () => {
	test("accepts lowercase alphanumeric with hyphens", () => {
		expect(isValidSkillName("mirror")).toBe(true);
		expect(isValidSkillName("show-my-tools")).toBe(true);
		expect(isValidSkillName("a1-b2-c3")).toBe(true);
	});

	test("rejects uppercase, spaces, dots, slashes", () => {
		expect(isValidSkillName("Mirror")).toBe(false);
		expect(isValidSkillName("my skill")).toBe(false);
		expect(isValidSkillName("my.skill")).toBe(false);
		expect(isValidSkillName("../etc/passwd")).toBe(false);
		expect(isValidSkillName("folder/name")).toBe(false);
	});

	test("rejects empty, starting-with-hyphen, starting-with-digit", () => {
		expect(isValidSkillName("")).toBe(false);
		expect(isValidSkillName("-mirror")).toBe(false);
		expect(isValidSkillName("1mirror")).toBe(false);
	});

	test("rejects null bytes", () => {
		expect(isValidSkillName("mirror\0evil")).toBe(false);
	});

	test("rejects names over 64 characters", () => {
		expect(isValidSkillName("a".repeat(64))).toBe(true);
		expect(isValidSkillName("a".repeat(65))).toBe(false);
	});
});

describe("getUserSkillsRoot", () => {
	test("honors PHANTOM_SKILLS_USER_ROOT override", () => {
		const tmp = mkdtempSync(join(tmpdir(), "phantom-skills-"));
		process.env.PHANTOM_SKILLS_USER_ROOT = tmp;
		try {
			expect(getUserSkillsRoot()).toBe(tmp);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});
});

describe("resolveUserSkillPath", () => {
	test("returns a path inside the skills root", () => {
		const tmp = mkdtempSync(join(tmpdir(), "phantom-skills-"));
		process.env.PHANTOM_SKILLS_USER_ROOT = tmp;
		try {
			const r = resolveUserSkillPath("mirror");
			expect(r.root).toBe(tmp);
			expect(r.dir.startsWith(tmp)).toBe(true);
			expect(r.file).toBe(join(tmp, "mirror", "SKILL.md"));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	});

	test("throws on invalid name", () => {
		expect(() => resolveUserSkillPath("../etc")).toThrow();
		expect(() => resolveUserSkillPath("")).toThrow();
	});
});
