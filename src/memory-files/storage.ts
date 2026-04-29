// CRUD for memory files under /home/phantom/.claude/**.md (excluding reserved
// subtrees). Atomic writes via tmp-then-rename. Subdirectories created on
// demand. Directory traversal blocked by paths.ts validation.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative as relPath } from "node:path";
import {
	EXCLUDED_TOP_DIRS,
	EXCLUDED_TOP_FILES,
	PHANTOM_CONFIG_MEMORY_ALLOWLIST,
	PHANTOM_CONFIG_VIRTUAL_PREFIX,
	getMemoryFilesRoot,
	getPhantomConfigMemoryRoot,
	isPhantomConfigMemoryPath,
	isValidMemoryFilePath,
	resolveMemoryFilePath,
	resolvePhantomConfigMemoryPath,
} from "./paths.ts";

const MAX_BYTES = 256 * 1024; // 256 KB per memory file

export type MemoryFileSummary = {
	path: string; // POSIX relative path from the root
	size: number;
	mtime: string; // ISO
	top_level: string;
	read_only?: boolean;
	description?: string;
};

export type MemoryFileDetail = MemoryFileSummary & {
	content: string;
};

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function walk(root: string, current: string, out: string[]): void {
	if (!existsSync(current)) return;
	let entries: string[];
	try {
		entries = readdirSync(current);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.startsWith(".")) continue;
		const full = join(current, name);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(full);
		} catch {
			continue;
		}
		const rel = relPath(root, full).split("\\").join("/");

		if (stats.isDirectory()) {
			const topSegment = rel.split("/")[0];
			if (EXCLUDED_TOP_DIRS.has(topSegment)) continue;
			walk(root, full, out);
			continue;
		}

		if (!stats.isFile()) continue;
		if (!name.endsWith(".md")) continue;

		const topSegment = rel.split("/")[0];
		if (rel === topSegment && EXCLUDED_TOP_FILES.has(topSegment)) continue;
		if (EXCLUDED_TOP_DIRS.has(topSegment)) continue;

		out.push(rel);
	}
}

const PHANTOM_CONFIG_DESCRIPTIONS: Record<string, string> = {
	"agent-notes.md": "Agent notes (the agent's own learnings, append-only)",
};

function listPhantomConfigMemoryFiles(): MemoryFileSummary[] {
	const root = getPhantomConfigMemoryRoot();
	const out: MemoryFileSummary[] = [];
	for (const name of PHANTOM_CONFIG_MEMORY_ALLOWLIST) {
		const absolute = join(root, name);
		if (!existsSync(absolute)) continue;
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(absolute);
		} catch {
			continue;
		}
		if (!stats.isFile()) continue;
		out.push({
			path: `${PHANTOM_CONFIG_VIRTUAL_PREFIX}${name}`,
			size: stats.size,
			mtime: stats.mtime.toISOString(),
			top_level: "phantom-config",
			read_only: true,
			description: PHANTOM_CONFIG_DESCRIPTIONS[name],
		});
	}
	return out;
}

export function listMemoryFiles(): { files: MemoryFileSummary[] } {
	const root = getMemoryFilesRoot();
	const relative: string[] = [];
	walk(root, root, relative);
	relative.sort();

	const files: MemoryFileSummary[] = [];
	for (const rel of relative) {
		if (!isValidMemoryFilePath(rel)) continue;
		const full = join(root, rel);
		let stats: ReturnType<typeof statSync>;
		try {
			stats = statSync(full);
		} catch {
			continue;
		}
		files.push({
			path: rel,
			size: stats.size,
			mtime: stats.mtime.toISOString(),
			top_level: rel.split("/")[0],
		});
	}

	// Surface read-only phantom-config memory files (currently just
	// agent-notes.md) alongside the Claude user memory files so operators can
	// watch the agent learn from the same dashboard tab. Writes are blocked in
	// this path because these files are append-only by the agent itself, and a
	// manual dashboard edit would race the agent.
	for (const entry of listPhantomConfigMemoryFiles()) {
		files.push(entry);
	}

	return { files };
}

export type ReadResult = { ok: true; file: MemoryFileDetail } | { ok: false; status: 404 | 422 | 500; error: string };

export function readMemoryFile(relative: string): ReadResult {
	if (isPhantomConfigMemoryPath(relative)) {
		let absolute: string;
		try {
			absolute = resolvePhantomConfigMemoryPath(relative).absolute;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, status: 422, error: msg };
		}
		if (!existsSync(absolute)) {
			return { ok: false, status: 404, error: `Memory file not found: ${relative}` };
		}
		let content: string;
		let stats: ReturnType<typeof statSync>;
		try {
			content = readFileSync(absolute, "utf-8");
			stats = statSync(absolute);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			return { ok: false, status: 500, error: `Failed to read memory file: ${msg}` };
		}
		const tail = relative.slice(PHANTOM_CONFIG_VIRTUAL_PREFIX.length);
		return {
			ok: true,
			file: {
				path: relative,
				size: stats.size,
				mtime: stats.mtime.toISOString(),
				top_level: "phantom-config",
				read_only: true,
				description: PHANTOM_CONFIG_DESCRIPTIONS[tail],
				content,
			},
		};
	}

	let absolute: string;
	try {
		absolute = resolveMemoryFilePath(relative).absolute;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}
	if (!existsSync(absolute)) {
		return { ok: false, status: 404, error: `Memory file not found: ${relative}` };
	}
	let content: string;
	let stats: ReturnType<typeof statSync>;
	try {
		content = readFileSync(absolute, "utf-8");
		stats = statSync(absolute);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to read memory file: ${msg}` };
	}
	return {
		ok: true,
		file: {
			path: relative,
			size: stats.size,
			mtime: stats.mtime.toISOString(),
			top_level: relative.split("/")[0],
			content,
		},
	};
}

function writeAtomic(file: string, content: string): void {
	const dir = dirname(file);
	ensureDir(dir);
	const tmp = join(dir, `.memory.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
	renameSync(tmp, file);
}

export type WriteResult =
	| { ok: true; file: MemoryFileDetail; previousContent: string | null }
	| { ok: false; status: 400 | 404 | 409 | 413 | 422 | 500; error: string };

export type WriteInput = {
	path: string;
	content: string;
};

export function writeMemoryFile(input: WriteInput, options: { mustExist: boolean }): WriteResult {
	if (isPhantomConfigMemoryPath(input.path)) {
		return {
			ok: false,
			status: 400,
			error: `Memory file is read-only in the dashboard: ${input.path}`,
		};
	}

	const byteLength = new TextEncoder().encode(input.content).byteLength;
	if (byteLength > MAX_BYTES) {
		return {
			ok: false,
			status: 413,
			error: `Content is ${(byteLength / 1024).toFixed(1)} KB, over the ${MAX_BYTES / 1024} KB limit.`,
		};
	}

	let absolute: string;
	try {
		absolute = resolveMemoryFilePath(input.path).absolute;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}

	let previousContent: string | null = null;
	if (existsSync(absolute)) {
		if (!options.mustExist) {
			return { ok: false, status: 409, error: `Memory file already exists: ${input.path}` };
		}
		try {
			previousContent = readFileSync(absolute, "utf-8");
		} catch {
			previousContent = null;
		}
	} else if (options.mustExist) {
		return { ok: false, status: 404, error: `Memory file not found: ${input.path}` };
	}

	try {
		writeAtomic(absolute, input.content);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to write memory file: ${msg}` };
	}

	const read = readMemoryFile(input.path);
	if (!read.ok) {
		return { ok: false, status: 500, error: `Write succeeded but read-back failed: ${read.error}` };
	}
	return { ok: true, file: read.file, previousContent };
}

export type DeleteResult =
	| { ok: true; deleted: string; previousContent: string | null }
	| { ok: false; status: 404 | 422 | 500; error: string };

export function deleteMemoryFile(relative: string): DeleteResult {
	if (isPhantomConfigMemoryPath(relative)) {
		return { ok: false, status: 422, error: `Memory file is read-only in the dashboard: ${relative}` };
	}

	let absolute: string;
	try {
		absolute = resolveMemoryFilePath(relative).absolute;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}
	if (!existsSync(absolute)) {
		return { ok: false, status: 404, error: `Memory file not found: ${relative}` };
	}
	let previousContent: string | null = null;
	try {
		previousContent = readFileSync(absolute, "utf-8");
	} catch {
		previousContent = null;
	}
	try {
		rmSync(absolute, { force: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to delete memory file: ${msg}` };
	}
	return { ok: true, deleted: relative, previousContent };
}

export const MEMORY_FILE_MAX_BYTES = MAX_BYTES;
