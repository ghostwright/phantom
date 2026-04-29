// Parse and serialize SKILL.md frontmatter.
//
// Format (verified from cli.js:9050-9112, see 03b findings doc):
//
//   ---
//   name: skill-name
//   description: one-line description
//   when_to_use: When Claude should auto-invoke this skill, including trigger phrases.
//   allowed-tools:
//     - Read
//     - Glob
//     - mcp__phantom-reflective__phantom_memory_search
//   argument-hint: "[topic]"
//   arguments:
//     - topic
//   context: inline
//   disable-model-invocation: false
//   ---
//
//   # Skill Title
//
//   body...
//
// The SDK only requires `name`, `description`, `when_to_use`. Everything else is
// optional. Zod validates the shape and rejects unknown fields loudly so typos
// surface to the user instead of silently doing nothing.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_BODY_BYTES = 50 * 1024; // 50 KB

export const SkillContextSchema = z.enum(["inline", "fork"]);
export const SkillSourceSchema = z.enum(["built-in", "agent", "user"]);

export const SkillFrontmatterSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(SKILL_NAME_PATTERN, "name must be lowercase letters, digits, and hyphens, starting with a letter"),
		description: z.string().min(1, "description is required").max(240),
		when_to_use: z.string().min(1, "when_to_use is required"),
		"allowed-tools": z.array(z.string().min(1)).optional(),
		"argument-hint": z.string().optional(),
		arguments: z.array(z.string().min(1)).optional(),
		context: SkillContextSchema.optional(),
		"disable-model-invocation": z.boolean().optional(),
		// Provenance marker. Omitted on user-authored skills (default treats
		// missing as "user"). Built-in skills shipped under skills-builtin/ set
		// this to "built-in" so the dashboard can group and badge them.
		// detectSource() in src/skills/storage.ts reads this field.
		"x-phantom-source": SkillSourceSchema.optional(),
	})
	.strict();

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export type ParsedSkill = {
	frontmatter: SkillFrontmatter;
	body: string;
};

export type ParseResult = { ok: true; parsed: ParsedSkill } | { ok: false; error: string };

export function parseFrontmatter(raw: string): ParseResult {
	if (typeof raw !== "string") {
		return { ok: false, error: "Input must be a string" };
	}

	const normalized = raw.replace(/^\uFEFF/, "");
	const lines = normalized.split(/\r?\n/);

	if (lines[0]?.trim() !== "---") {
		return { ok: false, error: "SKILL.md must start with a YAML frontmatter block opened by '---'" };
	}

	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			endIndex = i;
			break;
		}
	}
	if (endIndex === -1) {
		return { ok: false, error: "SKILL.md frontmatter block is not closed with '---'" };
	}

	const yamlText = lines.slice(1, endIndex).join("\n");
	const body = lines
		.slice(endIndex + 1)
		.join("\n")
		.replace(/^\n+/, "");

	let yamlParsed: unknown;
	try {
		yamlParsed = parseYaml(yamlText);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Invalid YAML frontmatter: ${msg}` };
	}

	if (yamlParsed == null || typeof yamlParsed !== "object") {
		return { ok: false, error: "Frontmatter must be a YAML object" };
	}

	const result = SkillFrontmatterSchema.safeParse(yamlParsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "frontmatter";
		return { ok: false, error: `${path}: ${issue.message}` };
	}

	return { ok: true, parsed: { frontmatter: result.data, body } };
}

export function serializeSkill(frontmatter: SkillFrontmatter, body: string): string {
	const ordered: Record<string, unknown> = {};
	// Keep x-phantom-source alongside name so the marker reads naturally at
	// the top of the YAML block and survives a round trip through the UI
	// PUT path. Without it in the list, every edit of a built-in skill
	// silently dropped the marker and demoted the skill to user-authored.
	const orderedKeys: Array<keyof SkillFrontmatter> = [
		"name",
		"x-phantom-source",
		"description",
		"when_to_use",
		"allowed-tools",
		"argument-hint",
		"arguments",
		"context",
		"disable-model-invocation",
	];
	for (const key of orderedKeys) {
		const value = frontmatter[key];
		if (value !== undefined) {
			ordered[key] = value;
		}
	}

	const yaml = stringifyYaml(ordered, { lineWidth: 0, defaultStringType: "PLAIN" }).trimEnd();
	const trimmedBody = body.replace(/^\n+/, "").replace(/\s+$/, "");
	return `---\n${yaml}\n---\n\n${trimmedBody}\n`;
}

export function getBodyByteLength(body: string): number {
	return new TextEncoder().encode(body).byteLength;
}

export function isBodyWithinLimit(body: string): boolean {
	return getBodyByteLength(body) <= MAX_BODY_BYTES;
}
