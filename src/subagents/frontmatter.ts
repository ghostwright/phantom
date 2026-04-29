// Parse and serialize subagent markdown frontmatter.
//
// Format verified against the bundled Claude Agent SDK CLI's own agent
// loader at node_modules/@anthropic-ai/claude-agent-sdk/cli.js (the FJ4
// reader around line 4601, plus the in-memory Zod schema pJ4 around line
// 4603). The CLI reads camelCase keys directly off the YAML frontmatter:
//
//   ---
//   name: <name>
//   description: "<description>"
//   tools: [Read, Grep]
//   disallowedTools: [Bash]
//   model: <opus|sonnet|haiku|inherit|full model id>
//   effort: <low|medium|high|<integer>>
//   color: <color>
//   memory: <user|project|local>
//   maxTurns: <positive integer>
//   initialPrompt: "<string>"
//   skills: [grep, Read]
//   mcpServers: [github, linear]
//   background: <boolean>
//   isolation: worktree
//   permissionMode: <default|acceptEdits|bypassPermissions|plan|dontAsk|auto>
//   ---
//
//   <system prompt body>
//
// The schema uses `.passthrough()` instead of `.strict()` so any
// forward-compat SDK field the CLI adds later survives a round trip.
// Phantom's editor renders only the known fields on read and preserves
// unknown fields on write. This also fixes the CRIT-3 hostility to
// CLI-authored agent files that carry camelCase fields Phantom did not
// previously declare.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

export const SUBAGENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
export const MAX_BODY_BYTES = 50 * 1024; // 50 KB, matches skills

// Matches MCP-tool-shaped names (letters, digits, underscores, hyphens,
// colons for the `mcp__server__tool` format). Rejects raw HTML and shell
// metacharacters to defend the chip input's attribute-embedded JSON.
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_:-]*$/;

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

// Verified against cli.js: the CLI's `wZ` constant is
// [...G28, "auto"] where G28 = ["acceptEdits", "bypassPermissions",
// "default", "dontAsk", "plan"]. We mirror that here.
export const AgentPermissionModeSchema = z.enum([
	"default",
	"acceptEdits",
	"bypassPermissions",
	"plan",
	"dontAsk",
	"auto",
]);

// Verified against cli.js FJ4 parser: memory is checked against the set
// ["user", "project", "local"]. Any other value triggers a CLI warning
// and is dropped. We tighten this from the former free-text field.
export const AgentMemorySchema = z.enum(["user", "project", "local"]);

export const AgentIsolationSchema = z.enum(["worktree"]);

export const SubagentFrontmatterSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.regex(SUBAGENT_NAME_PATTERN, "name must be lowercase letters, digits, and hyphens, starting with a letter"),
		description: z.string().min(1, "description is required").max(240),
		tools: z
			.array(
				z
					.string()
					.min(1)
					.regex(TOOL_NAME_PATTERN, "tool names may only contain letters, digits, underscore, colon, and hyphen"),
			)
			.optional(),
		disallowedTools: z
			.array(
				z
					.string()
					.min(1)
					.regex(TOOL_NAME_PATTERN, "tool names may only contain letters, digits, underscore, colon, and hyphen"),
			)
			.optional(),
		model: z.string().optional(),
		effort: AgentEffortSchema.optional(),
		color: AgentColorSchema.optional(),
		memory: AgentMemorySchema.optional(),
		maxTurns: z.number().int().min(1).max(200).optional(),
		initialPrompt: z.string().max(4000).optional(),
		skills: z.array(z.string().min(1)).optional(),
		mcpServers: z.array(z.string().min(1)).optional(),
		background: z.boolean().optional(),
		isolation: AgentIsolationSchema.optional(),
		permissionMode: AgentPermissionModeSchema.optional(),
	})
	.passthrough();

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

// Field order for the serialized YAML frontmatter block. Known fields
// land first in a deterministic order so the output is human-readable
// and git-diff friendly. Any unknown fields that survived parsing via
// `.passthrough()` are appended at the end in their original order so
// forward-compat SDK additions are preserved byte-for-byte on a round
// trip. Mirrors the CLI's own writer at cli.js:6131-6140 for the
// overlap of fields the CLI itself emits.
const ORDERED_KNOWN_KEYS: Array<keyof SubagentFrontmatter> = [
	"name",
	"description",
	"tools",
	"disallowedTools",
	"model",
	"effort",
	"color",
	"memory",
	"maxTurns",
	"initialPrompt",
	"skills",
	"mcpServers",
	"background",
	"isolation",
	"permissionMode",
];

export function serializeSubagent(frontmatter: SubagentFrontmatter, body: string): string {
	const ordered: Record<string, unknown> = {};
	const known = new Set<string>(ORDERED_KNOWN_KEYS as string[]);
	for (const key of ORDERED_KNOWN_KEYS) {
		const value = (frontmatter as Record<string, unknown>)[key as string];
		if (value !== undefined) {
			ordered[key as string] = value;
		}
	}
	// Preserve any passthrough fields the schema did not validate so a
	// round trip does not silently drop forward-compat SDK additions.
	for (const [key, value] of Object.entries(frontmatter as Record<string, unknown>)) {
		if (!known.has(key) && value !== undefined) {
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
