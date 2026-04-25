import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildConfigMemory } from "../config-memory.ts";

describe("buildConfigMemory", () => {
	const testDir = join(process.cwd(), "test-config-memory");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	test("returns empty string when directory does not exist", () => {
		const nonExistentDir = join(testDir, "does-not-exist");
		const result = buildConfigMemory(nonExistentDir);
		expect(result).toBe("");
	});

	test("returns empty string when directory exists but has no known files", () => {
		const result = buildConfigMemory(testDir);
		expect(result).toBe("");
	});

	test("returns empty string when files exist but are empty", () => {
		writeFileSync(join(testDir, "agent-notes.md"), "");
		writeFileSync(join(testDir, "corrections.md"), "");
		const result = buildConfigMemory(testDir);
		expect(result).toBe("");
	});

	test("returns file content with heading when file is under MAX_LINES", () => {
		const content = "# Test Notes\n\nThis is a short note.\nAnother line.";
		writeFileSync(join(testDir, "corrections.md"), content);

		const result = buildConfigMemory(testDir);

		expect(result).toContain("# Config Memory Files");
		expect(result).toContain("## corrections.md");
		expect(result).toContain("This is a short note.");
		expect(result).toContain("Another line.");
		expect(result).not.toContain("was truncated");
	});

	test("truncates file when over MAX_LINES with header + tail + compaction nudge", () => {
		const lines = ["# Header Line 1", "## Header Line 2", "### Header Line 3"];
		for (let i = 4; i <= 150; i++) {
			lines.push(`Line ${i}`);
		}
		const content = lines.join("\n");
		writeFileSync(join(testDir, "corrections.md"), content);

		const result = buildConfigMemory(testDir);

		expect(result).toContain("# Config Memory Files");
		expect(result).toContain("## corrections.md");
		expect(result).toContain("# Header Line 1");
		expect(result).toContain("## Header Line 2");
		expect(result).toContain("### Header Line 3");
		expect(result).toContain("<!-- corrections.md was truncated. Please compact this file. -->");
		expect(result).toContain("Line 150");
		// Middle lines should be omitted
		expect(result).not.toContain("Line 50");
	});

	test("processes multiple files independently", () => {
		writeFileSync(join(testDir, "corrections.md"), "# Corrections\n\nCorrection 1");
		writeFileSync(join(testDir, "principles.md"), "# Principles\n\nPrinciple 1");

		const result = buildConfigMemory(testDir);

		expect(result).toContain("## corrections.md");
		expect(result).toContain("Correction 1");
		expect(result).toContain("## principles.md");
		expect(result).toContain("Principle 1");
	});

	test("only reads known memory files, not arbitrary files", () => {
		writeFileSync(join(testDir, "corrections.md"), "# Known File\n\nThis should appear.");
		writeFileSync(join(testDir, "unknown-file.md"), "# Unknown File\n\nThis should NOT appear.");

		const result = buildConfigMemory(testDir);

		expect(result).toContain("corrections.md");
		expect(result).toContain("This should appear.");
		expect(result).not.toContain("unknown-file.md");
		expect(result).not.toContain("This should NOT appear.");
	});

	test("skips files that cannot be read", () => {
		writeFileSync(join(testDir, "corrections.md"), "# Good File\n\nContent here.");
		// Create a file but then remove it to simulate read failure scenario
		const badPath = join(testDir, "principles.md");
		writeFileSync(badPath, "temp");
		rmSync(badPath);

		const result = buildConfigMemory(testDir);

		// Should still process the good file
		expect(result).toContain("corrections.md");
		expect(result).toContain("Content here.");
		// Should not fail, just skip the missing file
		expect(result).not.toContain("principles.md");
	});

	test("handles all known memory files", () => {
		const knownFiles = ["corrections.md", "principles.md", "heartbeat-log.md", "presence-log.md"];

		for (const fileName of knownFiles) {
			writeFileSync(join(testDir, fileName), `# ${fileName}\n\nTest content for ${fileName}`);
		}

		const result = buildConfigMemory(testDir);

		for (const fileName of knownFiles) {
			expect(result).toContain(`## ${fileName}`);
			expect(result).toContain(`Test content for ${fileName}`);
		}
	});

	test("excludes agent-notes.md to avoid feedback loop", () => {
		writeFileSync(join(testDir, "agent-notes.md"), "# Agent Notes\n\nThis should NOT appear.");
		writeFileSync(join(testDir, "corrections.md"), "# Corrections\n\nThis should appear.");

		const result = buildConfigMemory(testDir);

		expect(result).not.toContain("agent-notes.md");
		expect(result).not.toContain("This should NOT appear.");
		expect(result).toContain("corrections.md");
		expect(result).toContain("This should appear.");
	});
});
