import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvolutionConfig } from "../../../evolution/config.ts";
import { EvolutionConfigSchema } from "../../../evolution/config.ts";
import type { EvolutionEngine } from "../../../evolution/engine.ts";
import type { EvolutionQueue, PoisonedRow } from "../../../evolution/queue.ts";
import type { EvolutionLogEntry, EvolutionMetrics, ReflectionStats } from "../../../evolution/types.ts";
import { handleEvolutionApi } from "../evolution.ts";

type MetricsShape = EvolutionMetrics & { reflection_stats?: Partial<ReflectionStats> };

let tmp = "";

function makeConfig(root: string): EvolutionConfig {
	const metaDir = join(root, "meta");
	const memoryDir = join(root, "memory");
	mkdirSync(metaDir, { recursive: true });
	mkdirSync(memoryDir, { recursive: true });
	writeFileSync(join(root, "constitution.md"), "immutable principles", "utf-8");
	return EvolutionConfigSchema.parse({
		paths: {
			config_dir: root,
			constitution: join(root, "constitution.md"),
			version_file: join(metaDir, "version.json"),
			metrics_file: join(metaDir, "metrics.json"),
			evolution_log: join(metaDir, "evolution-log.jsonl"),
			session_log: join(memoryDir, "session-log.jsonl"),
		},
	});
}

function seedVersion(
	config: EvolutionConfig,
	data: { version: number; parent: number | null; timestamp?: string },
): void {
	const payload = {
		version: data.version,
		parent: data.parent,
		timestamp: data.timestamp ?? "2026-04-15T10:00:00.000Z",
		changes: [],
		metrics_at_change: { session_count: 0, success_rate_7d: 0 },
	};
	writeFileSync(config.paths.version_file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function seedMetrics(config: EvolutionConfig, metrics: MetricsShape): void {
	writeFileSync(config.paths.metrics_file, `${JSON.stringify(metrics, null, 2)}\n`, "utf-8");
}

function seedLog(config: EvolutionConfig, entries: EvolutionLogEntry[]): void {
	const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
	writeFileSync(config.paths.evolution_log, body, "utf-8");
}

function buildStubEngine(config: EvolutionConfig): EvolutionEngine {
	return {
		getEvolutionConfig: () => config,
		getCurrentVersion: () => {
			try {
				const txt = require("node:fs").readFileSync(config.paths.version_file, "utf-8");
				return JSON.parse(txt).version ?? 0;
			} catch {
				return 0;
			}
		},
		getEvolutionLog: (limit: number) => {
			try {
				const txt = (require("node:fs").readFileSync(config.paths.evolution_log, "utf-8") as string).trim();
				if (!txt) return [];
				const lines = txt.split("\n").filter(Boolean) as string[];
				return lines.slice(-limit).map((l: string) => JSON.parse(l) as EvolutionLogEntry);
			} catch {
				return [];
			}
		},
		getMetrics: () => {
			try {
				const txt = require("node:fs").readFileSync(config.paths.metrics_file, "utf-8");
				return JSON.parse(txt);
			} catch {
				return {
					session_count: 0,
					success_count: 0,
					failure_count: 0,
					evolution_count: 0,
					last_session_at: null,
					last_evolution_at: null,
					success_rate_7d: 0,
				};
			}
		},
	} as unknown as EvolutionEngine;
}

function buildPoisonQueue(rows: PoisonedRow[]): EvolutionQueue {
	return { listPoisonPile: () => rows } as unknown as EvolutionQueue;
}

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, init);
}

function url(path: string): URL {
	return new URL(`http://localhost${path}`);
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phantom-evolution-test-"));
});

afterEach(() => {
	if (tmp) rmSync(tmp, { recursive: true, force: true });
	tmp = "";
});

describe("evolution API overview", () => {
	test("returns current version, metrics, and poison_count", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 7, parent: 6, timestamp: "2026-04-14T14:02:00.000Z" });
		seedMetrics(config, {
			session_count: 42,
			success_count: 38,
			failure_count: 4,
			evolution_count: 7,
			last_session_at: "2026-04-14T13:59:00.000Z",
			last_evolution_at: "2026-04-14T14:02:00.000Z",
			success_rate_7d: 0.91,
			reflection_stats: {
				drains: 12,
				stage_haiku_runs: 9,
				stage_sonnet_runs: 2,
				stage_opus_runs: 1,
				status_ok: 7,
				status_skip: 4,
				status_escalate_cap: 1,
				total_cost_usd: 0.42,
				sigkill_before_write: 0,
				sigkill_mid_write: 1,
				invariant_failed_hard: 2,
				files_touched: { "persona.md": 3, "strategies/tool-preferences.md": 5, "domain-knowledge.md": 1 },
			},
		});
		const engine = buildStubEngine(config);
		const queue = buildPoisonQueue([
			{
				id: 1,
				session_id: "s1",
				session_key: "chat:abc",
				gate_decision: { fire: true, source: "failsafe", reason: "", haiku_cost_usd: 0 },
				session_summary: {
					session_id: "s1",
					session_key: "chat:abc",
					user_id: "u1",
					user_messages: [],
					assistant_messages: [],
					tools_used: [],
					files_tracked: [],
					outcome: "success",
					cost_usd: 0,
					started_at: "2026-04-14T13:00:00.000Z",
					ended_at: "2026-04-14T13:02:00.000Z",
				},
				original_enqueued_at: "2026-04-14T13:02:00.000Z",
				poisoned_at: "2026-04-14T13:05:00.000Z",
				failure_reason: "invariant fail",
			},
		]);

		const res = await handleEvolutionApi(req("/ui/api/evolution"), url("/ui/api/evolution"), { engine, queue });
		expect(res).not.toBeNull();
		const r = res as Response;
		expect(r.status).toBe(200);
		const body = (await r.json()) as Record<string, unknown>;
		expect((body.current as Record<string, unknown>).version).toBe(7);
		expect((body.current as Record<string, unknown>).parent).toBe(6);
		expect(body.poison_count).toBe(1);
		const metrics = body.metrics as Record<string, unknown>;
		expect(metrics.session_count).toBe(42);
		const stats = metrics.reflection_stats as Record<string, unknown>;
		expect(stats.drains).toBe(12);
		expect(stats.cost_usd).toBe(0.42);
		const tiers = stats.tiers as Record<string, number>;
		expect(tiers.haiku).toBe(9);
		expect(tiers.sonnet).toBe(2);
		expect(tiers.opus).toBe(1);
		expect(stats.sigkills).toBe(1);
		expect(stats.invariant_fails).toBe(2);
		const files = stats.files_touched as Array<{ file: string; count: number }>;
		expect(files[0].file).toBe("strategies/tool-preferences.md");
		expect(files[0].count).toBe(5);
		expect(files.length).toBeLessThanOrEqual(10);
	});

	test("returns poison_count 0 when queue is absent", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 0, parent: null });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution"), url("/ui/api/evolution"), {
			engine,
		})) as Response;
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.poison_count).toBe(0);
	});

	test("defaults reflection_stats block when metrics.json lacks it", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 2, parent: 1 });
		seedMetrics(config, {
			session_count: 0,
			success_count: 0,
			failure_count: 0,
			evolution_count: 0,
			last_session_at: null,
			last_evolution_at: null,
			success_rate_7d: 0,
		});
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution"), url("/ui/api/evolution"), {
			engine,
		})) as Response;
		const body = (await res.json()) as Record<string, unknown>;
		const stats = (body.metrics as Record<string, unknown>).reflection_stats as Record<string, unknown>;
		expect(stats.drains).toBe(0);
		expect((stats.tiers as Record<string, number>).haiku).toBe(0);
		expect(stats.files_touched).toEqual([]);
	});

	test("405 on non-GET to overview", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution", { method: "POST" }), url("/ui/api/evolution"), {
			engine,
		})) as Response;
		expect(res.status).toBe(405);
	});
});

describe("evolution API timeline", () => {
	function entries(count: number): EvolutionLogEntry[] {
		const out: EvolutionLogEntry[] = [];
		for (let v = 1; v <= count; v++) {
			out.push({
				timestamp: `2026-04-${String(v).padStart(2, "0")}T10:00:00.000Z`,
				version: v,
				drain_id: `drain-${v}`,
				session_ids: [`sess-${v}`],
				tier: v % 3 === 0 ? "opus" : v % 2 === 0 ? "sonnet" : "haiku",
				status: "ok",
				changes_applied: 1,
				details: [
					{
						file: `meta/file-${v}.md`,
						type: "edit",
						summary: `Change ${v}`,
						rationale: "operator signal",
						session_ids: [`sess-${v}`],
					},
				],
			});
		}
		return out;
	}

	test("returns default limit and newest-first ordering", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 15, parent: 14 });
		seedLog(config, entries(15));
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/timeline"), url("/ui/api/evolution/timeline"), {
			engine,
		})) as Response;
		const body = (await res.json()) as { entries: EvolutionLogEntry[]; has_more: boolean };
		expect(body.entries.length).toBe(15);
		expect(body.entries[0].version).toBe(15);
		expect(body.entries[14].version).toBe(1);
		expect(body.has_more).toBe(false);
	});

	test("paginates with has_more when limit less than count", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 30, parent: 29 });
		seedLog(config, entries(30));
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(
			req("/ui/api/evolution/timeline?limit=10"),
			url("/ui/api/evolution/timeline?limit=10"),
			{ engine },
		)) as Response;
		const body = (await res.json()) as { entries: EvolutionLogEntry[]; has_more: boolean };
		expect(body.entries.length).toBe(10);
		expect(body.entries[0].version).toBe(30);
		expect(body.has_more).toBe(true);
	});

	test("before_version filters to older entries", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 12, parent: 11 });
		seedLog(config, entries(12));
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(
			req("/ui/api/evolution/timeline?before_version=5"),
			url("/ui/api/evolution/timeline?before_version=5"),
			{ engine },
		)) as Response;
		const body = (await res.json()) as { entries: EvolutionLogEntry[]; has_more: boolean };
		expect(body.entries.length).toBe(4);
		expect(body.entries[0].version).toBe(4);
		expect(body.entries[3].version).toBe(1);
		expect(body.has_more).toBe(false);
	});

	test("422 on non-integer limit", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(
			req("/ui/api/evolution/timeline?limit=abc"),
			url("/ui/api/evolution/timeline?limit=abc"),
			{ engine },
		)) as Response;
		expect(res.status).toBe(422);
	});

	test("422 on limit > 100", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(
			req("/ui/api/evolution/timeline?limit=150"),
			url("/ui/api/evolution/timeline?limit=150"),
			{ engine },
		)) as Response;
		expect(res.status).toBe(422);
	});

	test("405 on non-GET to timeline", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(
			req("/ui/api/evolution/timeline", { method: "POST" }),
			url("/ui/api/evolution/timeline"),
			{ engine },
		)) as Response;
		expect(res.status).toBe(405);
	});
});

describe("evolution API version detail", () => {
	test("current version returns full version record with diff content", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 3, parent: 2 });
		const log: EvolutionLogEntry[] = [
			{
				timestamp: "2026-04-14T10:00:00.000Z",
				version: 3,
				drain_id: "drain-3",
				session_ids: ["s3"],
				tier: "sonnet",
				status: "ok",
				changes_applied: 1,
				details: [
					{
						file: "persona.md",
						type: "edit",
						summary: "sharpened tone",
						rationale: "operator feedback",
						session_ids: ["s3"],
					},
				],
			},
		];
		seedLog(config, log);
		writeFileSync(join(tmp, "persona.md"), "# Persona\nHello world.\n", "utf-8");

		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/3"), url("/ui/api/evolution/version/3"), {
			engine,
		})) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			version: { version: number; parent: number | null };
			diff: Array<{
				file: string;
				type: string;
				summary: string;
				rationale: string;
				current_content: string;
				current_size: number;
				session_ids: string[];
			}>;
			has_snapshot: boolean;
		};
		expect(body.version.version).toBe(3);
		expect(body.version.parent).toBe(2);
		expect(body.has_snapshot).toBe(false);
		expect(body.diff.length).toBe(1);
		expect(body.diff[0].file).toBe("persona.md");
		expect(body.diff[0].current_content).toContain("Hello world");
		expect(body.diff[0].current_size).toBeGreaterThan(0);
	});

	test("historical version synthesizes parent as n-1", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 5, parent: 4 });
		const log: EvolutionLogEntry[] = [
			{
				timestamp: "2026-04-10T10:00:00.000Z",
				version: 2,
				drain_id: "d2",
				session_ids: ["s2"],
				tier: "haiku",
				status: "skip",
				changes_applied: 0,
				details: [],
			},
		];
		seedLog(config, log);
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/2"), url("/ui/api/evolution/version/2"), {
			engine,
		})) as Response;
		expect(res.status).toBe(200);
		const body = (await res.json()) as { version: { version: number; parent: number | null }; diff: unknown[] };
		expect(body.version.version).toBe(2);
		expect(body.version.parent).toBe(1);
		expect(body.diff).toEqual([]);
	});

	test("unknown version returns 404", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 5, parent: 4 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/99"), url("/ui/api/evolution/version/99"), {
			engine,
		})) as Response;
		expect(res.status).toBe(404);
	});

	test("deleted file yields empty current_content", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 2, parent: 1 });
		seedLog(config, [
			{
				timestamp: "2026-04-14T10:00:00.000Z",
				version: 2,
				drain_id: "d2",
				session_ids: ["s2"],
				tier: "haiku",
				status: "ok",
				changes_applied: 1,
				details: [
					{
						file: "removed-file.md",
						type: "delete",
						summary: "retired stub",
						rationale: "no longer needed",
						session_ids: ["s2"],
					},
				],
			},
		]);
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/2"), url("/ui/api/evolution/version/2"), {
			engine,
		})) as Response;
		const body = (await res.json()) as { diff: Array<{ current_content: string; current_size: number }> };
		expect(body.diff[0].current_content).toBe("");
		expect(body.diff[0].current_size).toBe(0);
	});

	test("path traversal in details[].file yields empty preview, does not read outside config_dir", async () => {
		const config = makeConfig(tmp);
		// Write a sentinel file outside config_dir so we would notice if the
		// traversal accidentally succeeded.
		const outsidePath = `${tmp}/SECRET_outside_config_dir.txt`;
		writeFileSync(outsidePath, "SHOULD-NOT-LEAK");
		seedVersion(config, { version: 9, parent: 8 });
		seedLog(config, [
			{
				timestamp: "2026-04-14T10:00:00.000Z",
				version: 9,
				drain_id: "d9",
				session_ids: ["s9"],
				tier: "haiku",
				status: "ok",
				changes_applied: 1,
				details: [
					{
						file: "../SECRET_outside_config_dir.txt",
						type: "edit",
						summary: "attempted traversal",
						rationale: "should be blocked",
						session_ids: ["s9"],
					},
				],
			},
		]);
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/9"), url("/ui/api/evolution/version/9"), {
			engine,
		})) as Response;
		const body = (await res.json()) as { diff: Array<{ current_content: string; current_size: number }> };
		expect(body.diff[0].current_content).toBe("");
		expect(body.diff[0].current_size).toBe(0);
	});

	test("file content exceeding 64 KB is truncated, size is the full byte length", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 3, parent: 2 });
		seedLog(config, [
			{
				timestamp: "2026-04-14T10:00:00.000Z",
				version: 3,
				drain_id: "d3",
				session_ids: ["s3"],
				tier: "sonnet",
				status: "ok",
				changes_applied: 1,
				details: [
					{
						file: "big.md",
						type: "edit",
						summary: "x",
						rationale: "y",
						session_ids: ["s3"],
					},
				],
			},
		]);
		const big = "a".repeat(70 * 1024);
		writeFileSync(join(tmp, "big.md"), big, "utf-8");
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/3"), url("/ui/api/evolution/version/3"), {
			engine,
		})) as Response;
		const body = (await res.json()) as { diff: Array<{ current_content: string; current_size: number }> };
		expect(body.diff[0].current_size).toBe(70 * 1024);
		expect(body.diff[0].current_content.length).toBe(64 * 1024);
	});

	test("has_snapshot is always false in Phase A", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		seedLog(config, [
			{
				timestamp: "2026-04-14T10:00:00.000Z",
				version: 1,
				drain_id: "d1",
				session_ids: [],
				tier: "haiku",
				status: "ok",
				changes_applied: 0,
				details: [],
			},
		]);
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/1"), url("/ui/api/evolution/version/1"), {
			engine,
		})) as Response;
		const body = (await res.json()) as { has_snapshot: boolean };
		expect(body.has_snapshot).toBe(false);
	});

	test("400 on non-integer path parameter", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/version/abc"), url("/ui/api/evolution/version/abc"), {
			engine,
		})) as Response;
		expect(res.status).toBe(400);
	});

	test("405 on non-GET to version", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		seedLog(config, [
			{
				timestamp: "2026-04-14T10:00:00.000Z",
				version: 1,
				drain_id: "d1",
				session_ids: [],
				tier: "haiku",
				status: "ok",
				changes_applied: 0,
				details: [],
			},
		]);
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(
			req("/ui/api/evolution/version/1", { method: "POST" }),
			url("/ui/api/evolution/version/1"),
			{ engine },
		)) as Response;
		expect(res.status).toBe(405);
	});
});

describe("evolution API misrouting", () => {
	test("returns null for unrelated path", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = await handleEvolutionApi(req("/ui/api/other"), url("/ui/api/other"), { engine });
		expect(res).toBeNull();
	});

	test("returns 404 for unknown /ui/api/evolution/ sub-path", async () => {
		const config = makeConfig(tmp);
		seedVersion(config, { version: 1, parent: 0 });
		const engine = buildStubEngine(config);
		const res = (await handleEvolutionApi(req("/ui/api/evolution/nonsense"), url("/ui/api/evolution/nonsense"), {
			engine,
		})) as Response;
		expect(res.status).toBe(404);
	});
});
