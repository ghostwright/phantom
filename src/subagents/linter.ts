// Lint a subagent file for common mistakes. Advisory only, per the Cardinal
// Rule: the agent (and the operator) is the brain. We surface obvious red
// flags so the user knows what they are shipping.

import { MAX_BODY_BYTES, type SubagentFrontmatter, getBodyByteLength } from "./frontmatter.ts";

export type LintLevel = "info" | "warning" | "error";

export type LintHint = {
	level: LintLevel;
	field: string;
	message: string;
};

const SHELL_RED_LIST: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /rm\s+-rf\s+\//, label: "rm -rf /" },
	{ pattern: /curl[^\n]*\|\s*sh/, label: "curl | sh" },
	{ pattern: /wget[^\n]*\|\s*sh/, label: "wget | sh" },
	{ pattern: /\|\s*sudo/, label: "pipe to sudo" },
	{ pattern: /base64\s+-d[^\n]*\|\s*sh/, label: "base64 -d | sh" },
	{ pattern: /chmod\s+777/, label: "chmod 777" },
	{ pattern: /eval\s*\(\s*['"]/, label: "eval() with string literal" },
];

export function lintSubagent(frontmatter: SubagentFrontmatter, body: string): LintHint[] {
	const hints: LintHint[] = [];

	if (!frontmatter.tools || frontmatter.tools.length === 0) {
		hints.push({
			level: "info",
			field: "tools",
			message:
				"No tools set. This subagent will inherit all tools from the parent agent. Consider narrowing the tool list for least-privilege.",
		});
	}

	if (frontmatter.description.length < 20) {
		hints.push({
			level: "warning",
			field: "description",
			message:
				"description is very short. The Task tool reads this to decide when to invoke the subagent; write something descriptive so it fires at the right moments.",
		});
	}

	const bytes = getBodyByteLength(body);
	if (bytes > MAX_BODY_BYTES) {
		hints.push({
			level: "error",
			field: "body",
			message: `Body is ${(bytes / 1024).toFixed(1)} KB, over the ${MAX_BODY_BYTES / 1024} KB limit.`,
		});
	} else if (bytes > MAX_BODY_BYTES * 0.8) {
		hints.push({
			level: "info",
			field: "body",
			message: `Body is ${(bytes / 1024).toFixed(1)} KB, approaching the ${MAX_BODY_BYTES / 1024} KB limit.`,
		});
	}

	for (const { pattern, label } of SHELL_RED_LIST) {
		if (pattern.test(body)) {
			hints.push({
				level: "warning",
				field: "body",
				message: `Body contains a pattern often used in destructive shell commands: ${label}.`,
			});
		}
	}

	if (!/^#\s+/m.test(body)) {
		hints.push({
			level: "info",
			field: "body",
			message:
				"Body does not start with a Markdown heading. Conventional subagent prompts use '# Agent name' as the first line.",
		});
	}

	if (hints.length === 0) {
		hints.push({
			level: "info",
			field: "body",
			message: "All checks passed.",
		});
	}

	return hints;
}

export function hasBlockingError(hints: LintHint[]): boolean {
	return hints.some((h) => h.level === "error");
}
