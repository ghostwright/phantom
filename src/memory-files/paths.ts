// Resolve and validate memory file paths under the user-scope .claude directory.
//
// Memory files are arbitrary `.md` files the operator writes as instructions for
// their agent. They live under /home/phantom/.claude/ (the user-scope settings
// root that the SDK loads). We expose everything under that root EXCEPT:
//
//   - skills/**  (has its own tab)
//   - plugins/** (PR2 scope)
//   - agents/**  (PR3 scope)
//   - settings.json, settings.local.json (PR3 scope, JSON not markdown)
//   - any non-.md file
//   - hidden files (names starting with '.')
//
// Paths are always validated to live canonically under the root.

import { homedir } from "node:os";
import { resolve } from "node:path";

const USER_ENV_OVERRIDE = "PHANTOM_MEMORY_FILES_ROOT";
const PHANTOM_CONFIG_MEMORY_OVERRIDE = "PHANTOM_CONFIG_MEMORY_ROOT";

// Segments under .claude that we do NOT expose as memory files.
// Top-level hits are excluded; nested hits with the same top-level segment
// are also excluded.
export const EXCLUDED_TOP_DIRS = new Set<string>(["skills", "plugins", "agents"]);
export const EXCLUDED_TOP_FILES = new Set<string>(["settings.json", "settings.local.json"]);

// Virtual-path prefix the dashboard uses to surface files from
// `phantom-config/memory/` without mixing them into the `.claude/` walk.
// Files under this prefix are read-only in the dashboard: the agent writes
// them during evolution, and manual edits would race the agent's appends.
export const PHANTOM_CONFIG_VIRTUAL_PREFIX = "phantom-config/memory/";

// Allow-list of phantom-config memory files the dashboard surfaces. Kept
// explicit so the dashboard never accidentally reveals an unrelated file
// from the phantom-config tree.
export const PHANTOM_CONFIG_MEMORY_ALLOWLIST = new Set<string>(["agent-notes.md"]);

export function getMemoryFilesRoot(): string {
	const override = process.env[USER_ENV_OVERRIDE];
	if (override) {
		return resolve(override);
	}
	return resolve(homedir(), ".claude");
}

export function getPhantomConfigMemoryRoot(): string {
	const override = process.env[PHANTOM_CONFIG_MEMORY_OVERRIDE];
	if (override) {
		return resolve(override);
	}
	return resolve(process.cwd(), "phantom-config/memory");
}

/**
 * Returns true when the given virtual path points at a read-only phantom-
 * config memory file. The dashboard uses this both for listing (attaching
 * the `read_only` flag) and for gating writes/deletes.
 */
export function isPhantomConfigMemoryPath(relative: string): boolean {
	if (!relative.startsWith(PHANTOM_CONFIG_VIRTUAL_PREFIX)) return false;
	const tail = relative.slice(PHANTOM_CONFIG_VIRTUAL_PREFIX.length);
	return PHANTOM_CONFIG_MEMORY_ALLOWLIST.has(tail);
}

/**
 * Resolve a phantom-config virtual path to its on-disk location. Throws if
 * the path is not in the allow-list.
 */
export function resolvePhantomConfigMemoryPath(relative: string): { absolute: string } {
	if (!isPhantomConfigMemoryPath(relative)) {
		throw new Error(`Not a surfaced phantom-config memory path: ${JSON.stringify(relative)}`);
	}
	const tail = relative.slice(PHANTOM_CONFIG_VIRTUAL_PREFIX.length);
	const root = getPhantomConfigMemoryRoot();
	const absolute = resolve(root, tail);
	if (!absolute.startsWith(`${root}/`) && absolute !== root) {
		throw new Error(`Path escape detected: ${absolute} is not inside ${root}`);
	}
	return { absolute };
}

// The public-facing "path" is the relative path from the memory files root,
// always POSIX-style. We validate that:
//   - path has no null bytes
//   - path does not start with '/' or '\\'
//   - path has no '..' segments
//   - path ends with '.md'
//   - path is not a hidden file (no segment starts with '.')
//   - path is not under an excluded top-level directory
//   - path is not an excluded top-level file
export function isValidMemoryFilePath(relative: string): boolean {
	if (typeof relative !== "string" || relative.length === 0) return false;
	if (relative.includes("\0")) return false;
	if (relative.startsWith("/") || relative.startsWith("\\")) return false;
	if (!relative.endsWith(".md")) return false;

	const segments = relative.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return false;

	for (const seg of segments) {
		if (seg === "." || seg === "..") return false;
		if (seg.startsWith(".")) return false;
	}

	const top = segments[0];
	if (segments.length === 1 && EXCLUDED_TOP_FILES.has(top)) return false;
	if (EXCLUDED_TOP_DIRS.has(top)) return false;

	return true;
}

export function resolveMemoryFilePath(relative: string): { root: string; absolute: string } {
	if (!isValidMemoryFilePath(relative)) {
		throw new Error(`Invalid memory file path: ${JSON.stringify(relative)}`);
	}
	const root = getMemoryFilesRoot();
	const absolute = resolve(root, relative);
	if (!absolute.startsWith(`${root}/`) && absolute !== root) {
		throw new Error(`Path escape detected: ${absolute} is not inside ${root}`);
	}
	return { root, absolute };
}
