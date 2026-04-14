import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getUserSubagentsRoot, isValidSubagentName, resolveUserSubagentPath } from "../paths.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-subagents-paths-"));
	process.env.PHANTOM_SUBAGENTS_USER_ROOT = tmp;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	Reflect.deleteProperty(process.env, "PHANTOM_SUBAGENTS_USER_ROOT");
});

describe("isValidSubagentName", () => {
	test("accepts simple names", () => {
		expect(isValidSubagentName("research-intern")).toBe(true);
		expect(isValidSubagentName("a")).toBe(true);
		expect(isValidSubagentName("alpha123")).toBe(true);
	});

	test("rejects capital letters", () => {
		expect(isValidSubagentName("Research-Intern")).toBe(false);
	});

	test("rejects names starting with a digit", () => {
		expect(isValidSubagentName("7-experts")).toBe(false);
	});

	test("rejects names with underscores, dots, slashes", () => {
		expect(isValidSubagentName("a_b")).toBe(false);
		expect(isValidSubagentName("a.b")).toBe(false);
		expect(isValidSubagentName("a/b")).toBe(false);
	});

	test("rejects names with null bytes", () => {
		expect(isValidSubagentName("foo\0bar")).toBe(false);
	});

	test("rejects reserved stems", () => {
		expect(isValidSubagentName("agent")).toBe(false);
		expect(isValidSubagentName("agents")).toBe(false);
		expect(isValidSubagentName("default")).toBe(false);
		expect(isValidSubagentName("builtin")).toBe(false);
		expect(isValidSubagentName("index")).toBe(false);
	});

	test("rejects empty names", () => {
		expect(isValidSubagentName("")).toBe(false);
	});

	test("rejects names over 64 chars", () => {
		expect(isValidSubagentName(`a${"b".repeat(64)}`)).toBe(false);
	});

	test("rejects non-string inputs", () => {
		expect(isValidSubagentName(null as unknown as string)).toBe(false);
		expect(isValidSubagentName(undefined as unknown as string)).toBe(false);
		expect(isValidSubagentName(7 as unknown as string)).toBe(false);
	});
});

describe("getUserSubagentsRoot", () => {
	test("honors the env override", () => {
		expect(getUserSubagentsRoot()).toBe(tmp);
	});
});

describe("resolveUserSubagentPath", () => {
	test("resolves to <root>/<name>.md", () => {
		const r = resolveUserSubagentPath("research-intern");
		expect(r.root).toBe(tmp);
		expect(r.file).toBe(join(tmp, "research-intern.md"));
	});

	test("throws on invalid name", () => {
		expect(() => resolveUserSubagentPath("BAD NAME")).toThrow(/Invalid subagent name/);
	});

	test("throws on reserved name", () => {
		expect(() => resolveUserSubagentPath("agents")).toThrow(/Invalid subagent name/);
	});
});
