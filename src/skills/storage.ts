// Storage layer for SKILL.md files under the user-scope skills root.
//
// Atomic writes via tmp-then-rename on the same filesystem. No file locking:
// the founder's decision is last-write-wins. We still go through tmp+rename so
// a crash mid-write never leaves a torn file on disk.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	MAX_BODY_BYTES,
	type ParseResult,
	type SkillFrontmatter,
	getBodyByteLength,
	isBodyWithinLimit,
	parseFrontmatter,
	serializeSkill,
} from "./frontmatter.ts";
import { getUserSkillsRoot, isValidSkillName, resolveUserSkillPath } from "./paths.ts";

export type SkillSource = "user" | "built-in" | "agent" | "unknown";

export type SkillSummary = {
	name: string;
	description: string;
	when_to_use: string;
	source: SkillSource;
	path: string;
	mtime: string; // ISO
	size: number;
	has_allowed_tools: boolean;
	disable_model_invocation: boolean;
};

export type SkillDetail = SkillSummary & {
	frontmatter: SkillFrontmatter;
	body: string;
	raw: string;
};

export type ListResult = {
	skills: SkillSummary[];
	errors: Array<{ name: string; error: string }>;
};

const BUILT_IN_MARKER_FIELD = "x-phantom-source"; // optional, future use

function ensureDir(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function detectSource(frontmatter: SkillFrontmatter): SkillSource {
	const marker = (frontmatter as unknown as Record<string, unknown>)[BUILT_IN_MARKER_FIELD];
	if (typeof marker === "string") {
		if (marker === "built-in") return "built-in";
		if (marker === "agent") return "agent";
		if (marker === "user") return "user";
	}
	return "user";
}

function summaryFromParsed(
	name: string,
	path: string,
	raw: string,
	frontmatter: SkillFrontmatter,
	mtime: Date,
): SkillSummary {
	return {
		name,
		description: frontmatter.description,
		when_to_use: frontmatter.when_to_use,
		source: detectSource(frontmatter),
		path,
		mtime: mtime.toISOString(),
		size: new TextEncoder().encode(raw).byteLength,
		has_allowed_tools: Array.isArray(frontmatter["allowed-tools"]) && frontmatter["allowed-tools"].length > 0,
		disable_model_invocation: frontmatter["disable-model-invocation"] === true,
	};
}

export function listSkills(): ListResult {
	const root = getUserSkillsRoot();
	const errors: Array<{ name: string; error: string }> = [];
	const skills: SkillSummary[] = [];

	if (!existsSync(root)) {
		return { skills, errors };
	}

	let entries: string[];
	try {
		entries = readdirSync(root);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { skills, errors: [{ name: "", error: `Failed to list skills root: ${msg}` }] };
	}

	for (const entry of entries.sort()) {
		if (!isValidSkillName(entry)) {
			continue;
		}
		const skillFile = join(root, entry, "SKILL.md");
		if (!existsSync(skillFile)) {
			continue;
		}
		let raw: string;
		let stats: ReturnType<typeof statSync>;
		try {
			raw = readFileSync(skillFile, "utf-8");
			stats = statSync(skillFile);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			errors.push({ name: entry, error: `Failed to read: ${msg}` });
			continue;
		}

		const parsed = parseFrontmatter(raw);
		if (!parsed.ok) {
			errors.push({ name: entry, error: parsed.error });
			continue;
		}

		skills.push(summaryFromParsed(entry, skillFile, raw, parsed.parsed.frontmatter, stats.mtime));
	}

	// Built-in first (by mtime asc, stable), then user by mtime desc.
	skills.sort((a, b) => {
		const aBuiltin = a.source === "built-in" ? 0 : 1;
		const bBuiltin = b.source === "built-in" ? 0 : 1;
		if (aBuiltin !== bBuiltin) return aBuiltin - bBuiltin;
		if (a.source === "built-in") return a.name.localeCompare(b.name);
		return b.mtime.localeCompare(a.mtime);
	});

	return { skills, errors };
}

export type ReadResult = { ok: true; skill: SkillDetail } | { ok: false; status: 404 | 422 | 500; error: string };

export function readSkill(name: string): ReadResult {
	if (!isValidSkillName(name)) {
		return { ok: false, status: 422, error: `Invalid skill name: ${JSON.stringify(name)}` };
	}
	let file: string;
	try {
		file = resolveUserSkillPath(name).file;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}
	if (!existsSync(file)) {
		return { ok: false, status: 404, error: `Skill not found: ${name}` };
	}
	let raw: string;
	let stats: ReturnType<typeof statSync>;
	try {
		raw = readFileSync(file, "utf-8");
		stats = statSync(file);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to read skill: ${msg}` };
	}
	const parsed: ParseResult = parseFrontmatter(raw);
	if (!parsed.ok) {
		return { ok: false, status: 422, error: parsed.error };
	}
	const summary = summaryFromParsed(name, file, raw, parsed.parsed.frontmatter, stats.mtime);
	return {
		ok: true,
		skill: {
			...summary,
			frontmatter: parsed.parsed.frontmatter,
			body: parsed.parsed.body,
			raw,
		},
	};
}

export type WriteResult =
	| { ok: true; skill: SkillDetail; previousBody: string | null }
	| { ok: false; status: 400 | 404 | 409 | 413 | 422 | 500; error: string };

export type WriteInput = {
	name: string;
	frontmatter: SkillFrontmatter;
	body: string;
};

function writeAtomic(file: string, content: string): void {
	const dir = dirname(file);
	ensureDir(dir);
	const tmp = join(dir, `.SKILL.md.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, content, { encoding: "utf-8", mode: 0o644 });
	renameSync(tmp, file);
}

export function writeSkill(input: WriteInput, options: { mustExist: boolean }): WriteResult {
	const { name, frontmatter, body } = input;

	if (!isValidSkillName(name)) {
		return { ok: false, status: 422, error: `Invalid skill name: ${JSON.stringify(name)}` };
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
		file = resolveUserSkillPath(name).file;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}

	let previousBody: string | null = null;
	if (existsSync(file)) {
		if (!options.mustExist) {
			return { ok: false, status: 409, error: `Skill already exists: ${name}` };
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
		return { ok: false, status: 404, error: `Skill not found: ${name}` };
	}

	const serialized = serializeSkill(frontmatter, body);

	try {
		writeAtomic(file, serialized);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to write skill: ${msg}` };
	}

	const read = readSkill(name);
	if (!read.ok) {
		return { ok: false, status: 500, error: `Write succeeded but read-back failed: ${read.error}` };
	}
	return { ok: true, skill: read.skill, previousBody };
}

export type DeleteResult =
	| { ok: true; deleted: string; previousBody: string | null }
	| { ok: false; status: 404 | 422 | 500; error: string };

export function deleteSkill(name: string): DeleteResult {
	if (!isValidSkillName(name)) {
		return { ok: false, status: 422, error: `Invalid skill name: ${JSON.stringify(name)}` };
	}
	let dir: string;
	let file: string;
	try {
		const r = resolveUserSkillPath(name);
		dir = r.dir;
		file = r.file;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 422, error: msg };
	}
	if (!existsSync(file)) {
		return { ok: false, status: 404, error: `Skill not found: ${name}` };
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
		// Best-effort: remove the parent directory if empty
		try {
			rmSync(dir, { recursive: false });
		} catch {
			// directory not empty or missing; non-fatal
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, status: 500, error: `Failed to delete skill: ${msg}` };
	}
	return { ok: true, deleted: name, previousBody };
}
