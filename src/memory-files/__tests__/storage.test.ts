import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidMemoryFilePath } from "../paths.ts";
import { deleteMemoryFile, listMemoryFiles, readMemoryFile, writeMemoryFile } from "../storage.ts";

let tmp: string;
let phantomConfigTmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-memfiles-"));
	phantomConfigTmp = mkdtempSync(join(tmpdir(), "phantom-config-memory-storage-"));
	process.env.PHANTOM_MEMORY_FILES_ROOT = tmp;
	process.env.PHANTOM_CONFIG_MEMORY_ROOT = phantomConfigTmp;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	rmSync(phantomConfigTmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_MEMORY_FILES_ROOT");
	Reflect.deleteProperty(process.env, "PHANTOM_CONFIG_MEMORY_ROOT");
});

describe("isValidMemoryFilePath", () => {
	test("accepts canonical memory paths", () => {
		expect(isValidMemoryFilePath("CLAUDE.md")).toBe(true);
		expect(isValidMemoryFilePath("rules/no-friday.md")).toBe(true);
		expect(isValidMemoryFilePath("memory/people/cheema.md")).toBe(true);
	});

	test("rejects skills, plugins, agents subtrees", () => {
		expect(isValidMemoryFilePath("skills/mirror.md")).toBe(false);
		expect(isValidMemoryFilePath("plugins/x.md")).toBe(false);
		expect(isValidMemoryFilePath("agents/x.md")).toBe(false);
	});

	test("rejects settings.json files", () => {
		expect(isValidMemoryFilePath("settings.json")).toBe(false);
		expect(isValidMemoryFilePath("settings.local.json")).toBe(false);
	});

	test("rejects non-.md files", () => {
		expect(isValidMemoryFilePath("notes.txt")).toBe(false);
		expect(isValidMemoryFilePath("a.json")).toBe(false);
	});

	test("rejects hidden files and traversal", () => {
		expect(isValidMemoryFilePath(".hidden.md")).toBe(false);
		expect(isValidMemoryFilePath("../../etc/passwd.md")).toBe(false);
		expect(isValidMemoryFilePath("/absolute.md")).toBe(false);
		expect(isValidMemoryFilePath("null\0byte.md")).toBe(false);
	});
});

describe("listMemoryFiles", () => {
	test("finds markdown files under the root", () => {
		writeFileSync(join(tmp, "CLAUDE.md"), "top\n");
		mkdirSync(join(tmp, "rules"));
		writeFileSync(join(tmp, "rules", "no-friday.md"), "rule\n");
		mkdirSync(join(tmp, "memory"), { recursive: true });
		writeFileSync(join(tmp, "memory", "notes.md"), "notes\n");
		const result = listMemoryFiles();
		const paths = result.files.map((f) => f.path).sort();
		expect(paths).toContain("CLAUDE.md");
		expect(paths).toContain("rules/no-friday.md");
		expect(paths).toContain("memory/notes.md");
	});

	test("excludes skills/, plugins/, agents/", () => {
		mkdirSync(join(tmp, "skills", "mirror"), { recursive: true });
		writeFileSync(join(tmp, "skills", "mirror", "SKILL.md"), "skill\n");
		mkdirSync(join(tmp, "plugins", "x"), { recursive: true });
		writeFileSync(join(tmp, "plugins", "x", "p.md"), "plugin\n");
		mkdirSync(join(tmp, "agents"));
		writeFileSync(join(tmp, "agents", "a.md"), "agent\n");
		writeFileSync(join(tmp, "CLAUDE.md"), "top\n");
		const result = listMemoryFiles();
		const paths = result.files.map((f) => f.path);
		expect(paths).toContain("CLAUDE.md");
		expect(paths.some((p) => p.startsWith("skills/"))).toBe(false);
		expect(paths.some((p) => p.startsWith("plugins/"))).toBe(false);
		expect(paths.some((p) => p.startsWith("agents/"))).toBe(false);
	});

	test("excludes non-.md files and hidden files", () => {
		writeFileSync(join(tmp, "settings.json"), "{}");
		writeFileSync(join(tmp, ".hidden.md"), "h\n");
		writeFileSync(join(tmp, "notes.txt"), "t\n");
		writeFileSync(join(tmp, "CLAUDE.md"), "top\n");
		const result = listMemoryFiles();
		const paths = result.files.map((f) => f.path);
		expect(paths).toEqual(["CLAUDE.md"]);
	});
});

describe("writeMemoryFile + readMemoryFile", () => {
	test("creates a new file at a nested path", () => {
		const result = writeMemoryFile({ path: "memory/sub/notes.md", content: "hello\n" }, { mustExist: false });
		expect(result.ok).toBe(true);
		expect(existsSync(join(tmp, "memory", "sub", "notes.md"))).toBe(true);
		const read = readMemoryFile("memory/sub/notes.md");
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.file.content).toBe("hello\n");
	});

	test("refuses to create when file exists", () => {
		writeMemoryFile({ path: "CLAUDE.md", content: "first\n" }, { mustExist: false });
		const second = writeMemoryFile({ path: "CLAUDE.md", content: "second\n" }, { mustExist: false });
		expect(second.ok).toBe(false);
	});

	test("updates existing file", () => {
		writeMemoryFile({ path: "CLAUDE.md", content: "first\n" }, { mustExist: false });
		const updated = writeMemoryFile({ path: "CLAUDE.md", content: "second\n" }, { mustExist: true });
		expect(updated.ok).toBe(true);
		if (!updated.ok) return;
		expect(updated.previousContent).toBe("first\n");
		expect(updated.file.content).toBe("second\n");
	});

	test("rejects content over 256KB", () => {
		const giant = "x".repeat(300 * 1024);
		const result = writeMemoryFile({ path: "memory/giant.md", content: giant }, { mustExist: false });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
	});

	test("rejects invalid paths", () => {
		const result = writeMemoryFile({ path: "skills/evil.md", content: "nope" }, { mustExist: false });
		expect(result.ok).toBe(false);
	});
});

describe("deleteMemoryFile", () => {
	test("removes an existing file", () => {
		writeMemoryFile({ path: "CLAUDE.md", content: "c\n" }, { mustExist: false });
		const result = deleteMemoryFile("CLAUDE.md");
		expect(result.ok).toBe(true);
		expect(existsSync(join(tmp, "CLAUDE.md"))).toBe(false);
	});

	test("returns 404 for missing file", () => {
		const result = deleteMemoryFile("nope.md");
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(404);
	});
});
