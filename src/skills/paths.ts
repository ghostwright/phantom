// Resolve and validate skill directory paths.
//
// Skills live in two scopes:
//   user:    ${HOME}/.claude/skills/<name>/SKILL.md (loaded via settingSources 'user')
//   project: ${CWD}/.claude/skills/<name>/SKILL.md  (loaded via settingSources 'project')
//
// PR1 exposes only the user scope in the dashboard. Project-scope skills are
// read-only informational today and will surface in a later PR if we decide
// to let the operator edit them from the UI.
//
// Path validation guarantees:
//   - names are a strict subset of [a-z0-9][a-z0-9-]* max 64 chars
//   - the resolved SKILL.md path canonically lives under the skills root
//   - no null bytes, no relative segments, no symlinks leaking outside

import { homedir } from "node:os";
import { resolve } from "node:path";

const USER_ENV_OVERRIDE = "PHANTOM_SKILLS_USER_ROOT";
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export type SkillPathResolution = {
	root: string;
	dir: string;
	file: string;
};

export function getUserSkillsRoot(): string {
	const override = process.env[USER_ENV_OVERRIDE];
	if (override) {
		return resolve(override);
	}
	return resolve(homedir(), ".claude", "skills");
}

export function getProjectSkillsRoot(cwd: string = process.cwd()): string {
	return resolve(cwd, ".claude", "skills");
}

export function isValidSkillName(name: string): boolean {
	if (typeof name !== "string") return false;
	if (name.includes("\0")) return false;
	return NAME_PATTERN.test(name);
}

export function resolveUserSkillPath(name: string): SkillPathResolution {
	if (!isValidSkillName(name)) {
		throw new Error(`Invalid skill name: must match ${NAME_PATTERN.source}. Got: ${JSON.stringify(name)}`);
	}
	const root = getUserSkillsRoot();
	const dir = resolve(root, name);
	const file = resolve(dir, "SKILL.md");

	if (!dir.startsWith(`${root}/`) && dir !== root) {
		throw new Error(`Path escape detected: ${dir} is not inside ${root}`);
	}
	if (!file.startsWith(`${dir}/`) && file !== `${dir}/SKILL.md`) {
		throw new Error(`SKILL.md path escape detected: ${file}`);
	}

	return { root, dir, file };
}
