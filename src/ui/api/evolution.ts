// UI API routes for the Evolution dashboard tab (Phase A, read-only).
//
// All routes live under /ui/api/evolution and are cookie-auth gated by the
// dispatcher in src/ui/serve.ts.
//
//   GET /ui/api/evolution                                   -> current + metrics + poison_count
//   GET /ui/api/evolution/timeline?limit=&before_version=   -> paginated log
//   GET /ui/api/evolution/version/:n                        -> version + diff
//
// Read-only over phantom-config/meta/version.json, evolution-log.jsonl,
// metrics.json, plus the live config files under phantom-config/ for diff
// "current content" previews. NO rollback, NO writes. Snapshot storage and
// rollback ship in Phase B.

import { existsSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { z } from "zod";
import type { EvolutionEngine } from "../../evolution/engine.ts";
import { emptyReflectionStats } from "../../evolution/metrics.ts";
import type { EvolutionQueue } from "../../evolution/queue.ts";
import type { EvolutionLogEntry, EvolutionMetrics, EvolutionVersion, ReflectionStats } from "../../evolution/types.ts";
import { readVersion } from "../../evolution/versioning.ts";

export type EvolutionApiDeps = {
	engine: EvolutionEngine;
	queue?: EvolutionQueue | null;
};

const TIMELINE_DEFAULT_LIMIT = 20;
const TIMELINE_MAX_LIMIT = 100;
// Cap the in-memory scan window generously. Entries are small JSONL rows
// (~1-2 KB each), so reading 100k costs a few hundred MB of RAM briefly.
// Without this size, pagination via before_version silently cut off history
// past the last 500 entries on long-running deployments. If an agent ever
// crosses this ceiling, switch to a streaming reader.
const TIMELINE_SCAN_CAP = 100_000;
const FILE_PREVIEW_BYTE_CAP = 64 * 1024;
const TOP_FILES_LIMIT = 10;

const TimelineQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(TIMELINE_MAX_LIMIT).optional(),
	before_version: z.coerce.number().int().min(1).optional(),
});

type TimelineQuery = z.infer<typeof TimelineQuerySchema>;

type OverviewResponse = {
	current: { version: number; timestamp: string; parent: number | null };
	metrics: {
		session_count: number;
		evolution_count: number;
		success_rate_7d: number;
		last_session_at: string | null;
		last_evolution_at: string | null;
		reflection_stats: {
			drains: number;
			cost_usd: number;
			tiers: { haiku: number; sonnet: number; opus: number };
			status: { ok: number; skip: number; escalate_cap: number };
			invariant_fails: number;
			sigkills: number;
			files_touched: Array<{ file: string; count: number }>;
		};
	};
	poison_count: number;
};

type DiffEntry = {
	file: string;
	type: "edit" | "compact" | "new" | "delete";
	summary: string;
	rationale: string;
	current_content: string;
	current_size: number;
	session_ids: string[];
};

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

function zodMessage(error: z.ZodError): string {
	const issue = error.issues[0];
	const path = issue.path.length > 0 ? issue.path.join(".") : "query";
	return `${path}: ${issue.message}`;
}

function parseTimelineQuery(url: URL): { ok: true; value: TimelineQuery } | { ok: false; error: string } {
	const raw: Record<string, string> = {};
	const limit = url.searchParams.get("limit");
	const before = url.searchParams.get("before_version");
	if (limit !== null && limit.length > 0) raw.limit = limit;
	if (before !== null && before.length > 0) raw.before_version = before;
	const parsed = TimelineQuerySchema.safeParse(raw);
	if (!parsed.success) return { ok: false, error: zodMessage(parsed.error) };
	return { ok: true, value: parsed.data };
}

function readReflectionStatsFromMetrics(metrics: EvolutionMetrics): ReflectionStats {
	const block = (metrics as unknown as { reflection_stats?: Partial<ReflectionStats> }).reflection_stats;
	if (!block) return emptyReflectionStats();
	return { ...emptyReflectionStats(), ...block, files_touched: { ...(block.files_touched ?? {}) } };
}

function topFilesTouched(stats: ReflectionStats, limit: number): Array<{ file: string; count: number }> {
	const entries = Object.entries(stats.files_touched);
	entries.sort((a, b) => b[1] - a[1]);
	return entries.slice(0, limit).map(([file, count]) => ({ file, count }));
}

function buildOverview(deps: EvolutionApiDeps): OverviewResponse {
	const config = deps.engine.getEvolutionConfig();
	const version = readVersion(config);
	const metrics = deps.engine.getMetrics();
	const stats = readReflectionStatsFromMetrics(metrics);

	let poisonCount = 0;
	if (deps.queue) {
		try {
			poisonCount = deps.queue.listPoisonPile().length;
		} catch {
			poisonCount = 0;
		}
	}

	return {
		current: { version: version.version, timestamp: version.timestamp, parent: version.parent },
		metrics: {
			session_count: metrics.session_count,
			evolution_count: metrics.evolution_count,
			success_rate_7d: metrics.success_rate_7d,
			last_session_at: metrics.last_session_at,
			last_evolution_at: metrics.last_evolution_at,
			reflection_stats: {
				drains: stats.drains,
				cost_usd: stats.total_cost_usd,
				tiers: {
					haiku: stats.stage_haiku_runs,
					sonnet: stats.stage_sonnet_runs,
					opus: stats.stage_opus_runs,
				},
				status: {
					ok: stats.status_ok,
					skip: stats.status_skip,
					escalate_cap: stats.status_escalate_cap,
				},
				invariant_fails: stats.invariant_failed_hard,
				sigkills: stats.sigkill_before_write + stats.sigkill_mid_write,
				files_touched: topFilesTouched(stats, TOP_FILES_LIMIT),
			},
		},
		poison_count: poisonCount,
	};
}

// Read the evolution log in newest-first order. The underlying store holds
// append-only rows in chronological order; the engine helper returns the last
// N entries oldest-first. We reverse for the UI. We read `TIMELINE_SCAN_CAP`
// entries as the outer window so `before_version` pagination works without a
// full disk walk.
function readTimelineWindow(engine: EvolutionEngine): EvolutionLogEntry[] {
	const log = engine.getEvolutionLog(TIMELINE_SCAN_CAP);
	const copy = log.slice();
	copy.reverse();
	return copy;
}

function buildTimeline(
	engine: EvolutionEngine,
	query: TimelineQuery,
): { entries: EvolutionLogEntry[]; has_more: boolean } {
	const limit = query.limit ?? TIMELINE_DEFAULT_LIMIT;
	const window = readTimelineWindow(engine);
	const filtered = query.before_version ? window.filter((e) => e.version < (query.before_version as number)) : window;
	const page = filtered.slice(0, limit);
	const has_more = filtered.length > page.length;
	return { entries: page, has_more };
}

function overviewHandler(deps: EvolutionApiDeps): Response {
	return json(buildOverview(deps));
}

function timelineHandler(deps: EvolutionApiDeps, query: TimelineQuery): Response {
	return json(buildTimeline(deps.engine, query));
}

function readFilePreview(configDir: string, relPath: string): { content: string; size: number } {
	// Evolution log rows carry agent-written "file" paths. Resolve the candidate
	// absolute path and confirm it lands inside configDir before reading.
	// Without this guard, a log entry like "../../etc/passwd" would let the
	// dashboard disclose arbitrary host files up to FILE_PREVIEW_BYTE_CAP.
	const base = resolve(configDir);
	const absolute = resolve(base, relPath);
	const rel = relative(base, absolute);
	if (rel.startsWith("..") || rel === "" || resolve(base, rel) !== absolute) {
		return { content: "", size: 0 };
	}
	if (!existsSync(absolute)) return { content: "", size: 0 };
	let size = 0;
	try {
		size = statSync(absolute).size;
	} catch {
		size = 0;
	}
	try {
		const raw = readFileSync(absolute);
		const cap = FILE_PREVIEW_BYTE_CAP;
		const sliced = raw.length <= cap ? raw : raw.subarray(0, cap);
		return { content: sliced.toString("utf-8"), size };
	} catch {
		return { content: "", size };
	}
}

function versionHandler(deps: EvolutionApiDeps, versionNumber: number): Response {
	const config = deps.engine.getEvolutionConfig();
	const current = readVersion(config);
	const allLog = deps.engine.getEvolutionLog(TIMELINE_SCAN_CAP);
	const match = allLog.find((e) => e.version === versionNumber) ?? null;

	if (!match && versionNumber !== current.version) {
		return json({ error: "Version not found" }, { status: 404 });
	}

	let versionRecord: EvolutionVersion;
	if (versionNumber === current.version) {
		versionRecord = current;
	} else if (match) {
		versionRecord = {
			version: match.version,
			parent: match.version > 0 ? match.version - 1 : null,
			timestamp: match.timestamp,
			changes: match.details,
			metrics_at_change: { session_count: 0, success_rate_7d: 0 },
		};
	} else {
		return json({ error: "Version not found" }, { status: 404 });
	}

	const diffSource = match ? match.details : versionRecord.changes;
	const diff: DiffEntry[] = diffSource.map((change) => {
		const preview =
			change.type === "delete" ? { content: "", size: 0 } : readFilePreview(config.paths.config_dir, change.file);
		return {
			file: change.file,
			type: change.type,
			summary: change.summary,
			rationale: change.rationale,
			current_content: preview.content,
			current_size: preview.size,
			session_ids: change.session_ids,
		};
	});

	return json({ version: versionRecord, diff, has_snapshot: false });
}

export async function handleEvolutionApi(req: Request, url: URL, deps: EvolutionApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	if (pathname === "/ui/api/evolution") {
		if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
		return overviewHandler(deps);
	}

	if (pathname === "/ui/api/evolution/timeline") {
		if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
		const parsed = parseTimelineQuery(url);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
		return timelineHandler(deps, parsed.value);
	}

	const versionMatch = pathname.match(/^\/ui\/api\/evolution\/version\/([^/]+)$/);
	if (versionMatch) {
		if (req.method !== "GET") return json({ error: "Method not allowed" }, { status: 405 });
		const raw = versionMatch[1];
		const parsed = Number.parseInt(raw, 10);
		if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== raw) {
			return json({ error: "Version must be a non-negative integer" }, { status: 400 });
		}
		return versionHandler(deps, parsed);
	}

	if (pathname.startsWith("/ui/api/evolution/")) {
		return json({ error: "Not found" }, { status: 404 });
	}

	return null;
}
