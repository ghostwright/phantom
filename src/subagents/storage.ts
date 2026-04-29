// Storage layer for subagent markdown files under the user-scope agents root.
//
// Unlike skills (directory-per-skill with SKILL.md), subagents are flat files:
// `<root>/<name>.md`. Atomic writes via tmp-then-rename on the same filesystem.
// No file locking: last-write-wins per the Cardinal Rule. tmp+rename still
// protects against torn files on a mid-write crash.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
	MAX_BODY_BYTES,
	type ParseResult,
	type SubagentFrontmatter,
	getBodyByteLength,
	isBodyWithinLimit,
	parseFrontmatter,
	serializeSubagent,
} from "./frontmatter.ts";
import { getUserSubagentsRoot, isValidSubagentName, resolveUserSubagentPath } from "./paths.ts";

export type SubagentSummary = {
	name: string;
	description: string;
	path: string;
	mtime: string; // ISO
	size: number;
	has_tools: boolean;
	model: string | null;
	effort: string | null;
	color: string | null;
};

export type SubagentDetail = SubagentSummary & {
	frontmatter: SubagentFrontmatter;
	body: string;
	raw: string;
};

export type ListResult = {
	subagents: SubagentSummary[];
	errors: Array<{ name: string; error: string }>;
};

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function summaryFromParsed(
	name: string,
	path: string,
	raw: string,
	frontmatter: SubagentFrontmatter,
	mtime: Date,
): SubagentSummary {
	return {
		name,
		description: frontmatter.description,
		path,
		mtime: mtime.toISOString(),
		size: new TextEncoder().encode(raw).byteLength,
		has_tools: Array.isArray(frontmatter.tools) && frontmatter.tools.length > 0,
		model: frontmatter.model ?? null,
		effort: frontmatter.effort ?? null,
		color: frontmatter.color ?? null,
	};
}

export function listSubagents(): ListResult {
	const root = getUserSubagentsRoot();
	const errors: Array<{ name: string; error: string }> = [];
	const subagents: SubagentSummary[] = [];

	if (!existsSync(root)) {
		return { subagents, errors };
	}

	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { subagents, errors: [{ name: "", error: `Failed to list subagents root: ${msg}` }] };
	}

	for (const entry of entries.sort()) {
		if (!entry.endsWith(".md")) continue;
		const name = entry.slice(0, -3);
		if (!isValidSubagentName(name)) {
			continue;
		}
		const file = join(root, entry);
		let raw: string;
		let stats: ReturnType<typeof statSync>;
		try {
			raw = readFileSync(file, "utf-8");
			stats = statSync(file);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push({ name, error: `Failed to read: ${msg}` });
			continue;
		}

		const parsed = parseFrontmatter(raw);
		if (!parsed.ok) {
			errors.push({ name, error: parsed.error });
			continue;
		}

		subagents.push(summaryFromParsed(name, file, raw, parsed.parsed.frontmatter, stats.mtime));
	}

	subagents.sort((a, b) => b.mtime.localeCompare(a.mtime));
	return { subagents, errors };
}

export type ReadResult = { ok: true; subagent: SubagentDetail } | { ok: false; status: 404 | 422 | 500; error: string };

export function readSubagent(name: string): ReadResult {
	if (!isValidSubagentName(name)) {
		return { ok: false, status: 422, error: `Invalid subagent name: ${JSON.stringify(name)}` };
	}
	let file: string;
	try {
		file = resolveUserSubagentPath(name).file;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}
	if (!existsSync(file)) {
		return { ok: false, status: 404, error: `Subagent not found: ${name}` };
	}
	let raw: string;
	let stats: ReturnType<typeof statSync>;
	try {
		raw = readFileSync(file, "utf-8");
		stats = statSync(file);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to read subagent: ${msg}` };
	}
	const parsed: ParseResult = parseFrontmatter(raw);
	if (!parsed.ok) {
		return { ok: false, status: 422, error: parsed.error };
	}
	const summary = summaryFromParsed(name, file, raw, parsed.parsed.frontmatter, stats.mtime);
	return {
		ok: true,
		subagent: {
			...summary,
			frontmatter: parsed.parsed.frontmatter,
			body: parsed.parsed.body,
			raw,
		},
	};
}

export type WriteResult =
	| { ok: true; subagent: SubagentDetail; previousBody: string | null }
	| { ok: false; status: 400 | 404 | 409 | 413 | 422 | 500; error: string };

export type WriteInput = {
	name: string;
	frontmatter: SubagentFrontmatter;
	body: string;
};

function writeAtomic(file: string, content: string): void {
	const dir = dirname(file);
	ensureDir(dir);
	const base = basename(file);
	const tmp = join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
	renameSync(tmp, file);
}

export function writeSubagent(input: WriteInput, options: { mustExist: boolean }): WriteResult {
	const { name, frontmatter, body } = input;

	if (!isValidSubagentName(name)) {
		return { ok: false, status: 422, error: `Invalid subagent name: ${JSON.stringify(name)}` };
	}
	if (frontmatter.name !== name) {
		return {
			ok: false,
			status: 422,
			error: `Frontmatter name '${frontmatter.name}' does not match path name '${name}'`,
		};
	}
	if (!isBodyWithinLimit(body)) {
		return {
			ok: false,
			status: 413,
			error: `Body is ${(getBodyByteLength(body) / 1024).toFixed(1)} KB, over the ${MAX_BODY_BYTES / 1024} KB limit.`,
		};
	}

	let file: string;
	try {
		file = resolveUserSubagentPath(name).file;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}

	let previousBody: string | null = null;
	if (existsSync(file)) {
		if (!options.mustExist) {
			return { ok: false, status: 409, error: `Subagent already exists: ${name}` };
		}
		try {
			const prevRaw = readFileSync(file, "utf-8");
			const prevParsed = parseFrontmatter(prevRaw);
			if (prevParsed.ok) {
				previousBody = prevParsed.parsed.body;
			} else {
				previousBody = prevRaw;
			}
		} catch {
			previousBody = null;
		}
	} else if (options.mustExist) {
		return { ok: false, status: 404, error: `Subagent not found: ${name}` };
	}

	const serialized = serializeSubagent(frontmatter, body);

	try {
		writeAtomic(file, serialized);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to write subagent: ${msg}` };
	}

	const read = readSubagent(name);
	if (!read.ok) {
		return { ok: false, status: 500, error: `Write succeeded but read-back failed: ${read.error}` };
	}
	return { ok: true, subagent: read.subagent, previousBody };
}

export type DeleteResult =
	| { ok: true; deleted: string; previousBody: string | null }
	| { ok: false; status: 404 | 422 | 500; error: string };

export function deleteSubagent(name: string): DeleteResult {
	if (!isValidSubagentName(name)) {
		return { ok: false, status: 422, error: `Invalid subagent name: ${JSON.stringify(name)}` };
	}
	let file: string;
	try {
		file = resolveUserSubagentPath(name).file;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}
	if (!existsSync(file)) {
		return { ok: false, status: 404, error: `Subagent not found: ${name}` };
	}
	let previousBody: string | null = null;
	try {
		const prevRaw = readFileSync(file, "utf-8");
		const prevParsed = parseFrontmatter(prevRaw);
		previousBody = prevParsed.ok ? prevParsed.parsed.body : prevRaw;
	} catch {
		previousBody = null;
	}
	try {
		rmSync(file, { force: true });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to delete subagent: ${msg}` };
	}
	return { ok: true, deleted: name, previousBody };
}
