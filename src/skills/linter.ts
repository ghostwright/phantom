// Lint a SKILL.md for common mistakes and surface actionable warnings.
//
// The linter is advisory, not prescriptive. The Cardinal Rule says the agent is
// the brain; if a user wants to ship a skill with `Bash(*)` we let them. What
// we do is surface obvious shell red flags so they know what they are doing.

import { MAX_BODY_BYTES, type SkillFrontmatter, getBodyByteLength } from "./frontmatter.ts";

export type LintLevel = "info" | "warning" | "error";

export type LintHint = {
	level: LintLevel;
	field: string;
	message: string;
};

// Red-list patterns we warn on. Not a security boundary, just a nudge.
const SHELL_RED_LIST: Array<{ pattern: RegExp; label: string }> = [
	{ pattern: /rm\s+-rf\s+\//, label: "rm -rf /" },
	{ pattern: /curl[^\n]*\|\s*sh/, label: "curl | sh" },
	{ pattern: /wget[^\n]*\|\s*sh/, label: "wget | sh" },
	{ pattern: /\|\s*sudo/, label: "pipe to sudo" },
	{ pattern: /base64\s+-d[^\n]*\|\s*sh/, label: "base64 -d | sh" },
	{ pattern: /chmod\s+777/, label: "chmod 777" },
	{ pattern: /eval\s*\(\s*['"]/, label: "eval() with string literal" },
];

export function lintSkill(frontmatter: SkillFrontmatter, body: string): LintHint[] {
	const hints: LintHint[] = [];

	if (!frontmatter["allowed-tools"] || frontmatter["allowed-tools"].length === 0) {
		hints.push({
			level: "warning",
			field: "allowed-tools",
			message:
				"No allowed-tools set. The agent has full access by default. Consider listing the specific tools this skill needs.",
		});
	}

	const whenToUseWords = frontmatter.when_to_use.trim().split(/\s+/).length;
	if (whenToUseWords < 6) {
		hints.push({
			level: "warning",
			field: "when_to_use",
			message: "when_to_use should include trigger phrases so the model knows when to invoke this skill.",
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
			message: "Body does not start with a Markdown heading. Conventional SKILL.md uses '# Title' as the first line.",
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
