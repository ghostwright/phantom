// Parse and serialize subagent markdown frontmatter.
//
// Format verified against cli.js:6131-6141 (the CLI's own agent file writer)
// and sdk.d.ts:38-76 (AgentDefinition type). The CLI emits:
//
//   ---
//   name: <name>
//   description: "<description>"
//   tools: <comma-separated list>
//   model: <opus|sonnet|haiku|inherit|full model id>
//   effort: <low|medium|high>
//   color: <color>
//   memory: <text>
//   ---
//
//   <system prompt body>
//
// We accept a slightly richer superset on read (max-turns, initial-prompt,
// disallowed-tools) so dashboard-authored agents can express every
// AgentDefinition field that is practical to ship via a markdown file. Unknown
// fields are REJECTED at parse time via Zod .strict() so typos surface loudly.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_BODY_BYTES = 50 * 1024; // 50 KB, matches skills

const AGENT_COLORS = [
	"red",
	"orange",
	"yellow",
	"green",
	"cyan",
	"blue",
	"purple",
	"magenta",
	"white",
	"gray",
] as const;
export const AgentColorSchema = z.enum(AGENT_COLORS);

export const AgentEffortSchema = z.enum(["low", "medium", "high"]);

export const SubagentFrontmatterSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(SUBAGENT_NAME_PATTERN, "name must be lowercase letters, digits, and hyphens, starting with a letter"),
		description: z.string().min(1, "description is required").max(240),
		tools: z.array(z.string().min(1)).optional(),
		"disallowed-tools": z.array(z.string().min(1)).optional(),
		model: z.string().optional(),
		effort: AgentEffortSchema.optional(),
		color: AgentColorSchema.optional(),
		memory: z.string().max(2000).optional(),
		"max-turns": z.number().int().min(1).max(200).optional(),
		"initial-prompt": z.string().max(4000).optional(),
	})
	.strict();

export type SubagentFrontmatter = z.infer<typeof SubagentFrontmatterSchema>;

export type ParsedSubagent = {
	frontmatter: SubagentFrontmatter;
	body: string;
};

export type ParseResult = { ok: true; parsed: ParsedSubagent } | { ok: false; error: string };

export function parseFrontmatter(raw: string): ParseResult {
	if (typeof raw !== "string") {
		return { ok: false, error: "Input must be a string" };
	}

	const normalized = raw.replace(/^\uFEFF/, "");
	const lines = normalized.split(/\r?\n/);

	if (lines[0]?.trim() !== "---") {
		return { ok: false, error: "Subagent file must start with a YAML frontmatter block opened by '---'" };
	}

	let endIndex = -1;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			endIndex = i;
			break;
		}
	}
	if (endIndex === -1) {
		return { ok: false, error: "Subagent frontmatter block is not closed with '---'" };
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

	const result = SubagentFrontmatterSchema.safeParse(yamlParsed);
	if (!result.success) {
		const issue = result.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "frontmatter";
		return { ok: false, error: `${path}: ${issue.message}` };
	}

	return { ok: true, parsed: { frontmatter: result.data, body } };
}

export function serializeSubagent(frontmatter: SubagentFrontmatter, body: string): string {
	const ordered: Record<string, unknown> = {};
	// Field order mirrors the CLI's own agent writer at cli.js:6131-6140.
	const orderedKeys: Array<keyof SubagentFrontmatter> = [
		"name",
		"description",
		"tools",
		"disallowed-tools",
		"model",
		"effort",
		"color",
		"memory",
		"max-turns",
		"initial-prompt",
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
