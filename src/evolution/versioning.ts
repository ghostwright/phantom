import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { EvolutionConfig } from "./config.ts";
import type {
	EvolutionLogEntry,
	EvolutionVersion,
	MetricsSnapshot,
	ReflectionTier,
	SubprocessSentinel,
	SubprocessStatus,
	VersionChange,
} from "./types.ts";

/**
 * Read the current version from phantom-config/meta/version.json.
 */
export function readVersion(config: EvolutionConfig): EvolutionVersion {
	const path = config.paths.version_file;

	try {
		const text = readFileSync(path, "utf-8");
		return JSON.parse(text) as EvolutionVersion;
	} catch {
		return {
			version: 0,
			parent: null,
			timestamp: new Date().toISOString(),
			changes: [],
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		};
	}
}

/**
 * Write a new version to phantom-config/meta/version.json.
 */
export function writeVersion(config: EvolutionConfig, version: EvolutionVersion): void {
	const path = config.paths.version_file;
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(version, null, 2)}\n`, "utf-8");
}

/**
 * Create the next version from the current one.
 */
export function createNextVersion(
	current: EvolutionVersion,
	changes: VersionChange[],
	metricsSnapshot: MetricsSnapshot,
): EvolutionVersion {
	return {
		version: current.version + 1,
		parent: current.version,
		timestamp: new Date().toISOString(),
		changes,
		metrics_at_change: metricsSnapshot,
	};
}

/**
 * Walk evolution-log.jsonl and return up to `limit` recent entries in the
 * Phase 3 EvolutionLogEntry shape. Old pre-Phase-3 entries on disk
 * (singular session_id, append/replace/remove change types, content field)
 * are migrated on read so downstream consumers see one shape.
 */
export function getEvolutionLog(config: EvolutionConfig, limit = 50): EvolutionLogEntry[] {
	const historyPath = config.paths.evolution_log;
	const entries: EvolutionLogEntry[] = [];

	try {
		const text = readFileSync(historyPath, "utf-8").trim();
		if (!text) return [];

		const lines = text.split("\n").filter(Boolean);
		for (const line of lines.slice(-limit)) {
			try {
				const raw: unknown = JSON.parse(line);
				const migrated = migrateOldLogEntry(raw);
				if (migrated) entries.push(migrated);
			} catch {
				// Skip malformed lines.
			}
		}
	} catch {
		// No history file: return an empty log rather than synthesising
		// a fake entry. Callers (the MCP changelog resource, the engine
		// public surface) can render an empty list directly.
	}

	return entries;
}

/**
 * Up-convert a raw evolution-log.jsonl row to the Phase 3 EvolutionLogEntry
 * shape. The function accepts both the old shape (singular session_id,
 * details[].type in append|replace|remove, details[].content) and the new
 * shape (drain_id, session_ids[], tier, status, details[].type in
 * edit|compact|new|delete, details[].summary). Returns null when the row
 * is unrecognisable or missing the version field.
 *
 * The append-only evolution log persists on disk across upgrades, so
 * read-time migration is the only place backward compat is allowed in
 * Phase 3. Writers always emit the new shape.
 */
export function migrateOldLogEntry(raw: unknown): EvolutionLogEntry | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const version = typeof obj.version === "number" ? obj.version : null;
	if (version === null) return null;

	const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : new Date(0).toISOString();
	const drainId =
		typeof obj.drain_id === "string"
			? obj.drain_id
			: typeof obj.session_id === "string"
				? `legacy-${obj.session_id}`
				: `legacy-v${version}`;

	let sessionIds: string[];
	if (Array.isArray(obj.session_ids)) {
		sessionIds = obj.session_ids.filter((s): s is string => typeof s === "string");
	} else if (typeof obj.session_id === "string") {
		sessionIds = [obj.session_id];
	} else {
		sessionIds = [];
	}

	const tier = normaliseTier(obj.tier);
	const status = normaliseStatus(obj.status);
	const details = normaliseDetails(obj.details, sessionIds);
	const changesApplied = typeof obj.changes_applied === "number" ? obj.changes_applied : details.length;

	return {
		timestamp,
		version,
		drain_id: drainId,
		session_ids: sessionIds,
		tier,
		status,
		changes_applied: changesApplied,
		details,
	};
}

function normaliseTier(value: unknown): ReflectionTier | "skip" {
	if (value === "haiku" || value === "sonnet" || value === "opus" || value === "skip") return value;
	// Old-shape rows have no tier field. Default to "skip" so downstream
	// consumers do not need a special case for missing tier.
	return "skip";
}

function normaliseStatus(value: unknown): SubprocessStatus {
	if (value === "ok" || value === "skip" || value === "escalate") return value;
	// Old-shape rows have no status. They were always applied (otherwise
	// they would not be in the log), so map missing/unknown to "ok".
	return "ok";
}

function normaliseDetails(value: unknown, sessionIds: string[]): VersionChange[] {
	if (!Array.isArray(value)) return [];
	const out: VersionChange[] = [];
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const obj = item as Record<string, unknown>;
		const file = typeof obj.file === "string" ? obj.file : null;
		if (!file) continue;
		const type = mapDetailType(obj.type);
		// Old shape stored prose under `content`, new shape under `summary`.
		const summary = typeof obj.summary === "string" ? obj.summary : typeof obj.content === "string" ? obj.content : "";
		const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
		const itemSessionIds = Array.isArray(obj.session_ids)
			? obj.session_ids.filter((s): s is string => typeof s === "string")
			: sessionIds;
		out.push({ file, type, summary, rationale, session_ids: itemSessionIds });
	}
	return out;
}

function mapDetailType(value: unknown): VersionChange["type"] {
	switch (value) {
		case "edit":
		case "compact":
		case "new":
		case "delete":
			return value;
		case "append":
		case "replace":
			return "edit";
		case "remove":
			return "delete";
		default:
			return "edit";
	}
}

/**
 * Phase 3 directory snapshot.
 *
 * A snapshot is a Map from file path (relative to the config root) to its
 * exact byte contents. `snapshotDirectory` walks the phantom-config tree
 * excluding the `meta/` and `.staging/` subtrees; `restoreSnapshot` writes
 * the map back, recreating the directory layout and deleting any file that
 * was not present in the snapshot but exists now.
 *
 * The snapshot doubles as the pre-state for the invariant check (file
 * scope, constitution byte-compare, size bounds, near-duplicate detection).
 */
export type DirectorySnapshot = {
	version: EvolutionVersion;
	files: Map<string, string>;
};

const SNAPSHOT_EXCLUDED_DIRS = new Set(["meta", ".staging"]);

function walkConfigDir(root: string, current: string, out: string[]): void {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(current, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const absolute = join(current, entry.name);
		const rel = relative(root, absolute);
		if (entry.isDirectory()) {
			// Only exclude top-level `meta/` and `.staging/`. Nested directories
			// under writeable roots (e.g. `strategies/`, `memory/`) are in scope.
			if (rel === "meta" || rel === ".staging") continue;
			if (SNAPSHOT_EXCLUDED_DIRS.has(entry.name) && dirname(rel) === ".") continue;
			walkConfigDir(root, absolute, out);
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
}

/**
 * Capture the current state of phantom-config as an in-memory snapshot.
 * Excludes meta/ (engine telemetry) and .staging/ (subprocess scratch).
 */
export function snapshotDirectory(config: EvolutionConfig): DirectorySnapshot {
	const root = config.paths.config_dir;
	const files = new Map<string, string>();

	if (existsSync(root)) {
		const list: string[] = [];
		walkConfigDir(root, root, list);
		for (const rel of list) {
			try {
				const content = readFileSync(join(root, rel), "utf-8");
				files.set(rel, content);
			} catch {
				// Skip unreadable files: they will be treated as absent and
				// the invariant check will flag any post-run appearance as
				// a new write.
			}
		}
	}

	return {
		version: readVersion(config),
		files,
	};
}

/**
 * Restore the filesystem to the exact state captured in `snapshot`. Any
 * file present in the current state but missing from the snapshot is
 * deleted. Files whose content matches the snapshot are not rewritten so
 * the restore is a minimal-diff operation.
 */
export function restoreSnapshot(config: EvolutionConfig, snapshot: DirectorySnapshot): void {
	const root = config.paths.config_dir;

	// Walk the current state to find files that need to be deleted (present
	// now, absent in snapshot) before rewriting the survivors.
	const currentFiles: string[] = [];
	if (existsSync(root)) {
		walkConfigDir(root, root, currentFiles);
	}

	for (const rel of currentFiles) {
		if (!snapshot.files.has(rel)) {
			try {
				unlinkSync(join(root, rel));
			} catch {
				// Best effort: missing file is fine, permission errors should
				// not wedge the rollback path.
			}
		}
	}

	for (const [rel, content] of snapshot.files) {
		const abs = join(root, rel);
		let same = false;
		try {
			same = readFileSync(abs, "utf-8") === content;
		} catch {
			same = false;
		}
		if (same) continue;
		const dir = dirname(abs);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(abs, content, "utf-8");
	}

	// Restore version.json so the recorded current version matches the
	// pre-snapshot state. This lives under meta/ which is excluded from the
	// walk, so it needs an explicit write.
	writeVersion(config, snapshot.version);
}

/**
 * Produce a VersionChange[] describing the diff between a pre-snapshot and
 * the current post-subprocess state. Used by the reflection subprocess to
 * build the changelog entry that lands on disk and in the evolution log.
 *
 * Each changed file becomes one VersionChange whose `type` reflects the
 * subprocess's declared intent (edit, compact, new, delete). When the
 * subprocess sentinel annotates a file, the annotation wins. Otherwise the
 * diff drives the decision: a file absent pre and present post is "new", a
 * shrinkage larger than 30% with no annotation is "compact", everything
 * else is "edit".
 */
export function buildVersionChanges(
	pre: DirectorySnapshot,
	post: DirectorySnapshot,
	sentinel: SubprocessSentinel | null,
	sessionIds: string[],
	rationale: string,
): VersionChange[] {
	const changes: VersionChange[] = [];
	const annotated = new Map<string, { action?: "edit" | "compact" | "new"; summary?: string }>();
	if (sentinel?.changes) {
		for (const c of sentinel.changes) {
			annotated.set(c.file, { action: c.action, summary: c.summary });
		}
	}

	const preKeys = new Set(pre.files.keys());
	const postKeys = new Set(post.files.keys());
	const touched = new Set<string>();
	for (const k of preKeys) {
		if (!postKeys.has(k)) touched.add(k);
		else if (pre.files.get(k) !== post.files.get(k)) touched.add(k);
	}
	for (const k of postKeys) {
		if (!preKeys.has(k)) touched.add(k);
	}

	for (const rel of touched) {
		const preContent = pre.files.get(rel) ?? null;
		const postContent = post.files.get(rel) ?? null;
		const annotation = annotated.get(rel);

		let type: VersionChange["type"];
		if (postContent === null) {
			type = "delete";
		} else if (preContent === null) {
			type = "new";
		} else if (annotation?.action === "compact") {
			type = "compact";
		} else if (annotation?.action === "new") {
			// Subprocess asked for "new" but the file already existed pre.
			// Treat as edit rather than trusting the annotation blindly.
			type = "edit";
		} else {
			const preLines = preContent.split("\n").length;
			const postLines = postContent.split("\n").length;
			if (preLines > 0 && postLines < preLines * 0.7) {
				type = "compact";
			} else {
				type = annotation?.action ?? "edit";
			}
		}

		changes.push({
			file: rel,
			type,
			summary: annotation?.summary ?? describeDiff(preContent, postContent),
			rationale,
			session_ids: sessionIds,
		});
	}

	return changes;
}

function describeDiff(pre: string | null, post: string | null): string {
	if (pre === null && post !== null) return `new file, ${post.split("\n").length} lines`;
	if (post === null) return "file removed";
	const preLines = pre === null ? 0 : pre.split("\n").length;
	const postLines = post.split("\n").length;
	if (postLines === preLines) return `${postLines} lines, content edited`;
	const delta = postLines - preLines;
	const sign = delta > 0 ? "+" : "";
	return `${preLines} -> ${postLines} lines (${sign}${delta})`;
}
