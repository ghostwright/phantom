// Resolve and validate subagent file paths.
//
// Subagents live at:
//   user:    ${HOME}/.claude/agents/<name>.md (loaded via settingSources 'user')
//   project: ${CWD}/.claude/agents/<name>.md  (loaded via settingSources 'project')
//
// Unlike skills (which are directories with SKILL.md inside), subagents are
// flat markdown files. PR3 exposes only the user scope in the dashboard;
// project-scope subagents can still be created by the agent using the Write
// tool, but the dashboard CRUD flow targets the user volume.
//
// Path validation guarantees:
//   - names are a strict subset of [a-z0-9][a-z0-9-]* max 64 chars
//   - a small reserved-stem list is rejected to avoid collision with CLI
//     internal names (advisory, not a hard SDK constraint)
//   - the resolved <name>.md path canonically lives under the agents root
//   - no null bytes, no relative segments, no symlinks leaking outside

import { homedir } from "node:os";
import { resolve } from "node:path";

const USER_ENV_OVERRIDE = "PHANTOM_SUBAGENTS_USER_ROOT";
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const RESERVED_STEMS = new Set(["agent", "agents", "default", "builtin", "index"]);

export type SubagentPathResolution = {
	root: string;
	file: string;
};

export function getUserSubagentsRoot(): string {
	const override = process.env[USER_ENV_OVERRIDE];
	if (override) {
		return resolve(override);
	}
	return resolve(homedir(), ".claude", "agents");
}

export function getProjectSubagentsRoot(cwd: string = process.cwd()): string {
	return resolve(cwd, ".claude", "agents");
}

export function isValidSubagentName(name: string): boolean {
	if (typeof name !== "string") return false;
	if (name.includes("\0")) return false;
	if (!NAME_PATTERN.test(name)) return false;
	if (RESERVED_STEMS.has(name)) return false;
	return true;
}

export function resolveUserSubagentPath(name: string): SubagentPathResolution {
	if (!isValidSubagentName(name)) {
		throw new Error(
			`Invalid subagent name: must match ${NAME_PATTERN.source} and not be one of ${Array.from(RESERVED_STEMS).join(", ")}. Got: ${JSON.stringify(name)}`,
		);
	}
	const root = getUserSubagentsRoot();
	const file = resolve(root, `${name}.md`);

	if (!file.startsWith(`${root}/`) && file !== `${root}/${name}.md`) {
		throw new Error(`Subagent path escape detected: ${file} is not inside ${root}`);
	}

	return { root, file };
}
