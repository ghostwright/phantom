import { describe, expect, test } from "bun:test";
import {
	MAX_BODY_BYTES,
	getBodyByteLength,
	isBodyWithinLimit,
	parseFrontmatter,
	serializeSkill,
} from "../frontmatter.ts";

const validRaw = `---
name: mirror
description: weekly self-audit
when_to_use: Use on Friday evening.
allowed-tools:
  - Read
  - Glob
context: inline
---

# Mirror

## Goal
A body.
`;

describe("parseFrontmatter", () => {
	test("parses a valid SKILL.md", () => {
		const result = parseFrontmatter(validRaw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.frontmatter.name).toBe("mirror");
		expect(result.parsed.frontmatter.description).toBe("weekly self-audit");
		expect(result.parsed.frontmatter.when_to_use).toBe("Use on Friday evening.");
		expect(result.parsed.frontmatter["allowed-tools"]).toEqual(["Read", "Glob"]);
		expect(result.parsed.frontmatter.context).toBe("inline");
		expect(result.parsed.body.startsWith("# Mirror")).toBe(true);
	});

	test("rejects input without opening ---", () => {
		const result = parseFrontmatter("# No frontmatter here");
		expect(result.ok).toBe(false);
	});

	test("rejects input with no closing ---", () => {
		const result = parseFrontmatter("---\nname: m\n\n# body");
		expect(result.ok).toBe(false);
	});

	test("rejects missing required name", () => {
		const raw = "---\ndescription: x\nwhen_to_use: y\n---\n\n# body";
		const result = parseFrontmatter(raw);
		expect(result.ok).toBe(false);
	});

	test("rejects invalid name format", () => {
		const raw = "---\nname: Bad Name\ndescription: x\nwhen_to_use: y\n---\n\n# body";
		const result = parseFrontmatter(raw);
		expect(result.ok).toBe(false);
	});

	test("rejects unknown frontmatter keys (strict mode)", () => {
		const raw = "---\nname: m\ndescription: x\nwhen_to_use: y\nrogue: true\n---\n\n# body";
		const result = parseFrontmatter(raw);
		expect(result.ok).toBe(false);
	});

	test("accepts x-phantom-source marker for built-in skills", () => {
		const raw = `---
name: mirror
x-phantom-source: built-in
description: weekly self-audit
when_to_use: Use on Friday evening.
---

# Mirror
body
`;
		const result = parseFrontmatter(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.frontmatter["x-phantom-source"]).toBe("built-in");
	});

	test("accepts x-phantom-source marker for agent-authored skills", () => {
		const raw = `---
name: mirror
x-phantom-source: agent
description: weekly self-audit
when_to_use: Use on Friday evening.
---

# Mirror
body
`;
		const result = parseFrontmatter(raw);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.parsed.frontmatter["x-phantom-source"]).toBe("agent");
	});

	test("rejects invalid x-phantom-source values", () => {
		const raw = `---
name: mirror
x-phantom-source: bogus
description: weekly self-audit
when_to_use: Use on Friday evening.
---

# Mirror
body
`;
		const result = parseFrontmatter(raw);
		expect(result.ok).toBe(false);
	});
});

describe("serializeSkill", () => {
	test("round-trips a parsed skill", () => {
		const parsed = parseFrontmatter(validRaw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const serialized = serializeSkill(parsed.parsed.frontmatter, parsed.parsed.body);
		const reparsed = parseFrontmatter(serialized);
		expect(reparsed.ok).toBe(true);
		if (!reparsed.ok) return;
		expect(reparsed.parsed.frontmatter.name).toBe("mirror");
		expect(reparsed.parsed.body.startsWith("# Mirror")).toBe(true);
	});

	test("preserves x-phantom-source: built-in across a round trip", () => {
		const raw = `---
name: mirror
x-phantom-source: built-in
description: weekly self-audit
when_to_use: Use on Friday evening.
---

# Mirror
body
`;
		const parsed = parseFrontmatter(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const serialized = serializeSkill(parsed.parsed.frontmatter, parsed.parsed.body);
		expect(serialized).toContain("x-phantom-source: built-in");
		const reparsed = parseFrontmatter(serialized);
		expect(reparsed.ok).toBe(true);
		if (!reparsed.ok) return;
		expect(reparsed.parsed.frontmatter["x-phantom-source"]).toBe("built-in");
	});

	test("preserves x-phantom-source: user across a round trip", () => {
		const raw = `---
name: mirror
x-phantom-source: user
description: weekly self-audit
when_to_use: Use on Friday evening.
---

# Mirror
body
`;
		const parsed = parseFrontmatter(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const serialized = serializeSkill(parsed.parsed.frontmatter, parsed.parsed.body);
		expect(serialized).toContain("x-phantom-source: user");
		const reparsed = parseFrontmatter(serialized);
		expect(reparsed.ok).toBe(true);
		if (!reparsed.ok) return;
		expect(reparsed.parsed.frontmatter["x-phantom-source"]).toBe("user");
	});

	test("does not crash when frontmatter omits x-phantom-source", () => {
		const parsed = parseFrontmatter(validRaw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		// Strip any marker explicitly so we exercise the undefined branch
		const fmWithoutMarker = { ...parsed.parsed.frontmatter };
		Reflect.deleteProperty(fmWithoutMarker, "x-phantom-source");
		const serialized = serializeSkill(fmWithoutMarker, parsed.parsed.body);
		expect(serialized).not.toContain("x-phantom-source");
		const reparsed = parseFrontmatter(serialized);
		expect(reparsed.ok).toBe(true);
	});
});

describe("getBodyByteLength and isBodyWithinLimit", () => {
	test("counts UTF-8 bytes correctly", () => {
		expect(getBodyByteLength("hello")).toBe(5);
		expect(getBodyByteLength("café")).toBe(5);
	});

	test("isBodyWithinLimit enforces MAX_BODY_BYTES", () => {
		expect(isBodyWithinLimit("x")).toBe(true);
		expect(isBodyWithinLimit("x".repeat(MAX_BODY_BYTES))).toBe(true);
		expect(isBodyWithinLimit("x".repeat(MAX_BODY_BYTES + 1))).toBe(false);
	});
});
