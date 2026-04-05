import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LoopFrontmatter } from "./types.ts";

/**
 * The state file is the loop's memory across iterations. The runner only
 * inspects the YAML frontmatter to decide termination. The body belongs to
 * the agent and is opaque to TypeScript.
 *
 * Format:
 *   ---
 *   loop_id: <uuid>
 *   status: in-progress   # in-progress | done | blocked
 *   iteration: 0
 *   ---
 *   <markdown body>
 */

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export function initStateFile(path: string, loopId: string, goal: string): string {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) return readFileSync(path, "utf-8");

	const initial = `---
loop_id: ${loopId}
status: in-progress
iteration: 0
---

# Goal
${goal}

# Progress
(nothing yet)

# Next Action
Read this file, take one concrete step toward the goal, then update the
Progress and Next Action sections. When the goal is fully achieved, change
\`status\` in the frontmatter above to \`done\`.

# Notes
(empty)
`;
	writeFileSync(path, initial, "utf-8");
	return initial;
}

export function readStateFile(path: string): string {
	return readFileSync(path, "utf-8");
}

export function parseFrontmatter(contents: string): LoopFrontmatter | null {
	const match = FRONTMATTER_RE.exec(contents);
	if (!match) return null;

	const block = match[1];
	const fields: Record<string, string> = {};
	for (const line of block.split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim();
		if (key) fields[key] = value;
	}

	const loopId = fields.loop_id;
	const rawStatus = fields.status;
	const iteration = Number(fields.iteration);

	if (!loopId || !rawStatus || !Number.isFinite(iteration)) return null;
	if (rawStatus !== "in-progress" && rawStatus !== "done" && rawStatus !== "blocked") return null;

	return { loopId, status: rawStatus, iteration };
}
