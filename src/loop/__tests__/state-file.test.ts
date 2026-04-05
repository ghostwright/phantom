import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initStateFile, parseFrontmatter, readStateFile } from "../state-file.ts";

describe("loop state-file", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "phantom-loop-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("initStateFile creates file with frontmatter when missing", () => {
		const path = join(dir, "state.md");
		const contents = initStateFile(path, "loop-1", "Build a haiku");

		expect(existsSync(path)).toBe(true);
		expect(contents).toContain("loop_id: loop-1");
		expect(contents).toContain("status: in-progress");
		expect(contents).toContain("iteration: 0");
		expect(contents).toContain("Build a haiku");
	});

	test("initStateFile is idempotent - does not overwrite existing file", () => {
		const path = join(dir, "state.md");
		initStateFile(path, "loop-1", "Original goal");
		writeFileSync(path, "---\nloop_id: loop-1\nstatus: done\niteration: 5\n---\n\n# custom", "utf-8");

		const returned = initStateFile(path, "loop-1", "Original goal");
		const onDisk = readFileSync(path, "utf-8");

		expect(returned).toContain("status: done");
		expect(onDisk).toContain("iteration: 5");
		expect(onDisk).toContain("# custom");
	});

	test("parseFrontmatter extracts loop_id, status, iteration", () => {
		const contents = `---
loop_id: abc-123
status: in-progress
iteration: 3
---

body here`;
		const fm = parseFrontmatter(contents);
		expect(fm).toEqual({ loopId: "abc-123", status: "in-progress", iteration: 3 });
	});

	test("parseFrontmatter recognizes status: done", () => {
		const fm = parseFrontmatter("---\nloop_id: x\nstatus: done\niteration: 7\n---\n");
		expect(fm?.status).toBe("done");
	});

	test("parseFrontmatter recognizes status: blocked", () => {
		const fm = parseFrontmatter("---\nloop_id: x\nstatus: blocked\niteration: 1\n---\n");
		expect(fm?.status).toBe("blocked");
	});

	test("parseFrontmatter returns null when frontmatter missing", () => {
		expect(parseFrontmatter("# just a heading\n")).toBeNull();
	});

	test("parseFrontmatter returns null on invalid status value", () => {
		const fm = parseFrontmatter("---\nloop_id: x\nstatus: bogus\niteration: 1\n---\n");
		expect(fm).toBeNull();
	});

	test("parseFrontmatter returns null when required fields missing", () => {
		expect(parseFrontmatter("---\nstatus: done\niteration: 1\n---\n")).toBeNull();
		expect(parseFrontmatter("---\nloop_id: x\niteration: 1\n---\n")).toBeNull();
		expect(parseFrontmatter("---\nloop_id: x\nstatus: done\n---\n")).toBeNull();
	});

	test("readStateFile round-trips contents", () => {
		const path = join(dir, "state.md");
		writeFileSync(path, "hello\nworld", "utf-8");
		expect(readStateFile(path)).toBe("hello\nworld");
	});
});
