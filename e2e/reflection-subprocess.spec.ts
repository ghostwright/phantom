// Reflection subprocess e2e through the Agent SDK boundary.
//
// Opt in with:
//
//   PHANTOM_E2E_REFLECTION=1
//   PHANTOM_AGENT_SDK_MODULE=file:///Users/truffle/work/murph/packages/anthropic-sdk-shim/dist/index.js
//   PHANTOM_E2E_REFLECTION_MARKER=<unique marker phrase>
//
// Optional:
//
//   PHANTOM_E2E_REFLECTION_KEEP_TMP=1
//   PHANTOM_E2E_REFLECTION_TIMEOUT_MS=180000

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { QueuedSession } from "../src/evolution/queue.ts";

const REFLECTION_FLAG = readEnv("PHANTOM_E2E_REFLECTION");
const SDK_MODULE = readEnv("PHANTOM_AGENT_SDK_MODULE");
const MARKER = readEnv("PHANTOM_E2E_REFLECTION_MARKER");
const KEEP_TMP = readEnv("PHANTOM_E2E_REFLECTION_KEEP_TMP") === "1";
const TEST_TIMEOUT_MS = readIntEnv("PHANTOM_E2E_REFLECTION_TIMEOUT_MS") ?? 180_000;
const suite = REFLECTION_FLAG === "1" && SDK_MODULE && MARKER ? describe.serial : describe.skip;

type FileSnapshot = Map<string, string>;

suite("Phantom reflection subprocess e2e", () => {
	let tempRoot: string | null = null;

	afterEach(() => {
		if (tempRoot && !KEEP_TMP) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
		tempRoot = null;
	});

	test(
		"runs reflection against a temp phantom-config tree through the live runtime",
		async () => {
			const marker = mustEnv("PHANTOM_E2E_REFLECTION_MARKER", MARKER);
			tempRoot = mkdtempSync(join(tmpdir(), "phantom-e2e-reflection-"));
			const layout = seedTempTree(tempRoot);
			const before = snapshotTree(tempRoot);
			const protectedBefore = protectedFileContents(layout.configRoot);
			const queued = makeQueuedSessions(marker);

			const [{ loadEvolutionConfig }, { runReflectionSubprocess }] = await Promise.all([
				import("../src/evolution/config.ts"),
				import("../src/evolution/reflection-subprocess.ts"),
			]);
			const config = loadEvolutionConfig(layout.evolutionConfigPath);

			const result = await runReflectionSubprocess({
				batch: queued,
				config,
				phantomConfig: null,
			});

			expect(result.error).toBeNull();
			expect(result.status).toBe("ok");
			expect(result.invariantHardFailures).toEqual([]);
			expect(result.version).toBe(1);
			expect(result.changes.length).toBeGreaterThan(0);
			expect(result.statsDelta.sentinel_parse_fail ?? 0).toBe(0);

			const markerFiles = allowedMutationFilesWithMarker(layout.configRoot, marker);
			expect(markerFiles.length).toBeGreaterThan(0);

			const version = readJsonObject(join(layout.configRoot, "meta", "version.json"));
			expect(version.version).toBe(1);
			expect(version.parent).toBe(0);
			expect(Array.isArray(version.changes)).toBe(true);
			expect((version.changes as unknown[]).length).toBeGreaterThan(0);

			const logRows = readJsonlObjects(join(layout.configRoot, "meta", "evolution-log.jsonl"));
			expect(logRows).toHaveLength(1);
			expect(logRows[0]).toEqual(
				expect.objectContaining({
					version: 1,
					drain_id: result.drainId,
					tier: result.tier,
					changes_applied: result.changes.length,
				}),
			);
			for (const row of queued) {
				expect(logRows[0]?.session_ids).toContain(row.session_id);
			}

			expect(stagingIsAbsentOrEmpty(layout.configRoot)).toBe(true);
			expect(protectedFileContents(layout.configRoot)).toEqual(protectedBefore);

			const after = snapshotTree(tempRoot);
			const unexpected = changedPaths(before, after).filter((path) => !isExpectedChangedPath(path));
			expect(unexpected).toEqual([]);
			expect(topLevelEntries(tempRoot)).toEqual(["config", "phantom-config"]);
		},
		TEST_TIMEOUT_MS,
	);
});

function seedTempTree(root: string): { configRoot: string; evolutionConfigPath: string } {
	const configDir = join(root, "config");
	const configRoot = join(root, "phantom-config");
	mkdirSync(configDir, { recursive: true });
	mkdirSync(join(configRoot, "strategies"), { recursive: true });
	mkdirSync(join(configRoot, "memory"), { recursive: true });
	mkdirSync(join(configRoot, "meta"), { recursive: true });

	writeFileSync(join(configRoot, "constitution.md"), "1. Honesty\n2. Safety\n", "utf-8");
	writeFileSync(join(configRoot, "persona.md"), "# Persona\n\n- Be direct and useful.\n", "utf-8");
	writeFileSync(join(configRoot, "user-profile.md"), "# User Profile\n\n- Existing preference.\n", "utf-8");
	writeFileSync(join(configRoot, "domain-knowledge.md"), "# Domain Knowledge\n\n", "utf-8");
	writeFileSync(join(configRoot, "strategies", "task-patterns.md"), "# Task Patterns\n\n", "utf-8");
	writeFileSync(join(configRoot, "strategies", "tool-preferences.md"), "# Tool Preferences\n\n", "utf-8");
	writeFileSync(join(configRoot, "strategies", "error-recovery.md"), "# Error Recovery\n\n", "utf-8");
	writeFileSync(join(configRoot, "memory", "corrections.md"), "# Corrections\n\n", "utf-8");
	writeFileSync(join(configRoot, "memory", "principles.md"), "# Principles\n\n", "utf-8");
	writeFileSync(join(configRoot, "memory", "session-log.jsonl"), "", "utf-8");
	writeFileSync(join(configRoot, "memory", "agent-notes.md"), "# Agent Notes\n\n- Internal note.\n", "utf-8");
	writeFileSync(
		join(configRoot, "meta", "version.json"),
		`${JSON.stringify(
			{
				version: 0,
				parent: null,
				timestamp: "2026-04-28T00:00:00.000Z",
				changes: [],
				metrics_at_change: { session_count: 0, success_rate_7d: 0 },
			},
			null,
			2,
		)}\n`,
		"utf-8",
	);
	writeFileSync(join(configRoot, "meta", "metrics.json"), "{}\n", "utf-8");
	writeFileSync(join(configRoot, "meta", "evolution-log.jsonl"), "", "utf-8");

	const evolutionConfigPath = join(configDir, "evolution.yaml");
	writeFileSync(
		evolutionConfigPath,
		[
			"reflection:",
			'  enabled: "always"',
			"paths:",
			`  config_dir: ${JSON.stringify(configRoot)}`,
			`  constitution: ${JSON.stringify(join(configRoot, "constitution.md"))}`,
			`  version_file: ${JSON.stringify(join(configRoot, "meta", "version.json"))}`,
			`  metrics_file: ${JSON.stringify(join(configRoot, "meta", "metrics.json"))}`,
			`  evolution_log: ${JSON.stringify(join(configRoot, "meta", "evolution-log.jsonl"))}`,
			`  session_log: ${JSON.stringify(join(configRoot, "memory", "session-log.jsonl"))}`,
			"",
		].join("\n"),
		"utf-8",
	);

	return { configRoot, evolutionConfigPath };
}

function makeQueuedSessions(marker: string): QueuedSession[] {
	const now = new Date().toISOString();
	return [1, 2, 3].map((id): QueuedSession => {
		const sessionId = `reflection-e2e-${Date.now().toString(36)}-${id}`;
		const sessionKey = `e2e:${sessionId}`;
		return {
			id,
			session_id: sessionId,
			session_key: sessionKey,
			gate_decision: {
				fire: true,
				source: "haiku",
				reason: `explicit repeated user correction worth writing to ./user-profile.md: ${marker}`,
				haiku_cost_usd: 0,
			},
			session_summary: {
				session_id: sessionId,
				session_key: sessionKey,
				user_id: "reflection-e2e-user",
				user_messages: [
					[
						"This is an explicit correction for Phantom's durable memory, not a transient request.",
						`The exact durable user-profile preference to remember is: ${marker}.`,
						"The current temp user-profile file does not contain this preference yet.",
						"Write it only to an allowed cwd-relative memory file, preferably ./user-profile.md.",
					].join(" "),
				],
				assistant_messages: ["I missed that durable preference before. I should record it in ./user-profile.md."],
				tools_used: [],
				files_tracked: [],
				outcome: "success",
				cost_usd: 0.01,
				started_at: now,
				ended_at: now,
			},
			enqueued_at: now,
			retry_count: 0,
		};
	});
}

function protectedFileContents(configRoot: string): Record<string, string> {
	return {
		"constitution.md": readText(join(configRoot, "constitution.md")),
		"memory/session-log.jsonl": readText(join(configRoot, "memory", "session-log.jsonl")),
		"memory/agent-notes.md": readText(join(configRoot, "memory", "agent-notes.md")),
		"meta/metrics.json": readText(join(configRoot, "meta", "metrics.json")),
	};
}

function allowedMutationFilesWithMarker(configRoot: string, marker: string): string[] {
	return [...snapshotTree(configRoot).entries()]
		.filter(([path, content]) => isAllowedConfigMutationPath(path) && content.includes(marker))
		.map(([path]) => path)
		.sort();
}

function stagingIsAbsentOrEmpty(configRoot: string): boolean {
	const staging = join(configRoot, ".staging");
	if (!existsSync(staging)) return true;
	return readdirSync(staging).length === 0;
}

function snapshotTree(root: string): FileSnapshot {
	const out: FileSnapshot = new Map();
	walkFiles(root, root, out);
	return out;
}

function walkFiles(root: string, current: string, out: FileSnapshot): void {
	for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const absolute = join(current, entry.name);
		if (entry.isDirectory()) {
			walkFiles(root, absolute, out);
		} else if (entry.isFile()) {
			out.set(normalizeRel(relative(root, absolute)), readText(absolute));
		}
	}
}

function changedPaths(before: FileSnapshot, after: FileSnapshot): string[] {
	const keys = new Set([...before.keys(), ...after.keys()]);
	return [...keys]
		.filter((path) => before.get(path) !== after.get(path))
		.sort((left, right) => left.localeCompare(right));
}

function isExpectedChangedPath(path: string): boolean {
	if (path === "phantom-config/meta/version.json") return true;
	if (path === "phantom-config/meta/evolution-log.jsonl") return true;
	if (!path.startsWith("phantom-config/")) return false;
	return isAllowedConfigMutationPath(path.slice("phantom-config/".length));
}

function isAllowedConfigMutationPath(path: string): boolean {
	return (
		path === "persona.md" ||
		path === "user-profile.md" ||
		path === "domain-knowledge.md" ||
		path === "strategies/task-patterns.md" ||
		path === "strategies/tool-preferences.md" ||
		path === "strategies/error-recovery.md" ||
		(path.startsWith("strategies/") && path.endsWith(".md")) ||
		path === "memory/corrections.md" ||
		path === "memory/principles.md"
	);
}

function topLevelEntries(root: string): string[] {
	return readdirSync(root).sort((left, right) => left.localeCompare(right));
}

function readJsonObject(path: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(readText(path));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${path} did not contain a JSON object.`);
	}
	return parsed as Record<string, unknown>;
}

function readJsonlObjects(path: string): Record<string, unknown>[] {
	const text = readText(path).trim();
	if (!text) return [];
	return text.split("\n").map((line) => {
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`${path} contained a non-object JSONL row.`);
		}
		return parsed as Record<string, unknown>;
	});
}

function readText(path: string): string {
	return readFileSync(path, "utf-8");
}

function normalizeRel(path: string): string {
	return path.split(sep).join("/");
}

function readEnv(name: string): string | null {
	const value = process.env[name]?.trim();
	return value ? value : null;
}

function readIntEnv(name: string): number | null {
	const raw = readEnv(name);
	if (!raw) return null;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer. Received "${raw}".`);
	}
	return value;
}

function mustEnv(name: string, value: string | null): string {
	if (!value) throw new Error(`${name} is required for this e2e test.`);
	return value;
}
