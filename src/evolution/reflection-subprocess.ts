import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildProviderEnv } from "../config/providers.ts";
import type { PhantomConfig } from "../config/types.ts";
import type { EvolutionConfig } from "./config.ts";
import { runInvariantCheck } from "./invariant-check.ts";
import { JUDGE_MODEL_HAIKU, JUDGE_MODEL_OPUS, JUDGE_MODEL_SONNET } from "./judge-models.ts";
import type { QueuedSession } from "./queue.ts";
import { REFLECTION_SUBPROCESS_PROMPT, buildSubprocessSystemPrompt } from "./subprocess-prompt.ts";
import type {
	EvolutionLogEntry,
	ReflectionStats,
	ReflectionSubprocessResult,
	ReflectionTier,
	SubprocessSentinel,
	VersionChange,
} from "./types.ts";
import {
	buildVersionChanges,
	createNextVersion,
	readVersion,
	restoreSnapshot,
	snapshotDirectory,
	writeVersion,
} from "./versioning.ts";
import type { DirectorySnapshot } from "./versioning.ts";

// Phase 3 reflection subprocess entry point.
//
// The Cardinal Rule for this file: every line is plumbing. The agent inside
// the SDK subprocess decides what to learn, what to compact, when to skip,
// whether to promote between files, and which model tier to run at. This
// module does NOT classify content, NOT pick a tier based on batch size,
// NOT pre-filter observations. It snapshots, spawns, parses the sentinel,
// byte-compares the post state, commits or rolls back.

const TIER_TIMEOUTS_MS: Record<ReflectionTier, number> = {
	haiku: 60_000,
	sonnet: 180_000,
	opus: 300_000,
};

const TIER_MODELS: Record<ReflectionTier, string> = {
	haiku: JUDGE_MODEL_HAIKU,
	sonnet: JUDGE_MODEL_SONNET,
	opus: JUDGE_MODEL_OPUS,
};

function emptyStatsDelta(): Partial<ReflectionStats> {
	return { drains: 1 };
}

/**
 * Input to the subprocess runner. Passed as a single struct so the batch
 * processor does not need to know anything about the SDK.
 */
export type ReflectionSubprocessInput = {
	batch: QueuedSession[];
	config: EvolutionConfig;
	phantomConfig: PhantomConfig | null;
};

/**
 * Message yielded by the simulated SDK stream during tests. The production
 * path uses `query()` from the Agent SDK; tests inject a custom runner
 * that yields one of these shapes in a plain async iterable.
 */
export type SimulatedMessage =
	| { type: "assistant"; text: string; usage?: { input_tokens?: number; output_tokens?: number } }
	| {
			type: "result";
			subtype: "success" | string;
			text?: string;
			total_cost_usd?: number;
			usage?: { input_tokens?: number; output_tokens?: number };
	  }
	| { type: "error"; error: string };

export type SpawnQueryInput = {
	tier: ReflectionTier;
	drainId: string;
	batch: QueuedSession[];
	config: EvolutionConfig;
	phantomConfig: PhantomConfig | null;
	systemPrompt: string;
	abortSignal: AbortSignal;
};

export type SpawnQueryResult = {
	responseText: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	timedOut: boolean;
	sigkilled: boolean;
	error: string | null;
};

export type QueryRunner = (input: SpawnQueryInput) => Promise<SpawnQueryResult>;

// Test hook: runner overrides let unit tests replace the SDK spawn with a
// deterministic fixture. Production leaves this null and `runReflectionSubprocess`
// falls back to the default SDK runner.
let runnerOverride: QueryRunner | null = null;

export function __setReflectionRunnerForTest(runner: QueryRunner | null): void {
	runnerOverride = runner;
}

/**
 * Entry point called once per drain by the batch processor. The signature
 * takes the queue rows directly so the subprocess can stamp each bullet with
 * the originating session ids in the version change rationale.
 */
export async function runReflectionSubprocess(input: ReflectionSubprocessInput): Promise<ReflectionSubprocessResult> {
	const startedAt = Date.now();
	const drainId = `batch-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
	const stats: Partial<ReflectionStats> = emptyStatsDelta();

	const baseResult: ReflectionSubprocessResult = {
		drainId,
		status: "skip",
		tier: "haiku",
		escalatedFromTier: null,
		version: readVersion(input.config).version,
		changes: [],
		invariantHardFailures: [],
		invariantSoftWarnings: [],
		costUsd: 0,
		durationMs: 0,
		error: null,
		incrementRetryOnFailure: false,
		statsDelta: stats,
	};

	// Empty batch is a trivial skip. The cadence never calls us with an
	// empty batch but defensive zero-check keeps the flow testable.
	if (input.batch.length === 0) {
		baseResult.status = "skip";
		baseResult.durationMs = Date.now() - startedAt;
		stats.status_skip = 1;
		return baseResult;
	}

	// Stage 1: write the staging batch file for the subprocess to Read.
	const batchPath = writeStagingBatch(input.config, drainId, input.batch);
	// Stage 2: snapshot the pre-state for rollback and invariant comparison.
	const snapshot = snapshotDirectory(input.config);

	const runTier = async (
		tier: ReflectionTier,
		escalatedFrom: ReflectionTier | null,
	): Promise<ReflectionSubprocessResult> => {
		bumpTierStat(stats, tier);

		// Build the tier-stamped system prompt. Runtime context carries
		// plain facts (batch id, current version, file sizes) so the agent
		// can calibrate expectations before reading the real files.
		const fileSizes = computeFileSizes(snapshot);
		const systemPrompt = buildSubprocessSystemPrompt(REFLECTION_SUBPROCESS_PROMPT, {
			drainId,
			batchSessions: input.batch.length,
			currentVersion: snapshot.version.version,
			tier,
			fileSizesLines: fileSizes,
		});

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIER_TIMEOUTS_MS[tier]);
		const runner: QueryRunner = runnerOverride ?? defaultRunner;
		let queryResult: SpawnQueryResult;
		try {
			queryResult = await runner({
				tier,
				drainId,
				batch: input.batch,
				config: input.config,
				phantomConfig: input.phantomConfig,
				systemPrompt,
				abortSignal: controller.signal,
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			queryResult = {
				responseText: "",
				costUsd: 0,
				inputTokens: 0,
				outputTokens: 0,
				timedOut: false,
				sigkilled: true,
				error: msg,
			};
		} finally {
			clearTimeout(timer);
		}

		addCost(stats, queryResult.costUsd);
		baseResult.costUsd += queryResult.costUsd;

		// Subprocess crashed or timed out: restore snapshot, leave rows in
		// queue, no retry count bump.
		if (queryResult.error || queryResult.sigkilled || queryResult.timedOut) {
			const hadWrites = directoryChanged(snapshot, input.config);
			if (hadWrites) {
				restoreSnapshot(input.config, snapshot);
				if (queryResult.timedOut) bumpTimeout(stats, tier);
				else stats.sigkill_mid_write = (stats.sigkill_mid_write ?? 0) + 1;
			} else {
				if (queryResult.timedOut) bumpTimeout(stats, tier);
				else stats.sigkill_before_write = (stats.sigkill_before_write ?? 0) + 1;
			}
			baseResult.status = "skip"; // treated as a transient skip by caller
			baseResult.tier = tier;
			baseResult.escalatedFromTier = escalatedFrom;
			baseResult.error = queryResult.error ?? (queryResult.timedOut ? "timeout" : "sigkill");
			baseResult.incrementRetryOnFailure = false;
			cleanupStaging(batchPath);
			baseResult.durationMs = Date.now() - startedAt;
			return baseResult;
		}

		// Parse the final sentinel.
		const sentinel = parseSentinel(queryResult.responseText);
		if (sentinel === null) {
			stats.sentinel_parse_fail = (stats.sentinel_parse_fail ?? 0) + 1;
		}
		// Treat parse failure as status:"ok" with no annotation per failure
		// mode case 9: graceful degradation. The invariant check runs either
		// way.
		const effectiveSentinel: SubprocessSentinel = sentinel ?? { status: "ok" };

		// Escalate path. Restore any partial writes and respawn at the
		// target tier. One escalation per stage, capped at Opus.
		if (effectiveSentinel.status === "escalate") {
			const target: ReflectionTier | undefined = effectiveSentinel.target;
			const next = nextEscalationTier(tier, target ?? null);
			if (next === null) {
				// Either we are already at Opus or the agent asked for an
				// invalid target: cap hit.
				restoreSnapshot(input.config, snapshot);
				stats.escalation_cap_hit = (stats.escalation_cap_hit ?? 0) + 1;
				baseResult.status = "escalate";
				baseResult.tier = tier;
				baseResult.escalatedFromTier = escalatedFrom;
				baseResult.error = "escalation cap hit";
				baseResult.incrementRetryOnFailure = false;
				cleanupStaging(batchPath);
				baseResult.durationMs = Date.now() - startedAt;
				return baseResult;
			}
			restoreSnapshot(input.config, snapshot);
			bumpEscalation(stats, tier, next);
			return runTier(next, tier);
		}

		// Skip path. Nothing to commit.
		if (effectiveSentinel.status === "skip") {
			stats.status_skip = (stats.status_skip ?? 0) + 1;
			cleanupStaging(batchPath);
			baseResult.status = "skip";
			baseResult.tier = tier;
			baseResult.escalatedFromTier = escalatedFrom;
			baseResult.durationMs = Date.now() - startedAt;
			return baseResult;
		}

		// ok / compact path. Run the invariant check.
		const postSnapshot = snapshotDirectory(input.config);
		const invariant = runInvariantCheck(snapshot, postSnapshot, effectiveSentinel, input.config);

		baseResult.invariantHardFailures = invariant.hardFailures;
		baseResult.invariantSoftWarnings = invariant.softWarnings;
		if (invariant.softWarnings.length > 0) {
			stats.invariant_warned_soft = (stats.invariant_warned_soft ?? 0) + invariant.softWarnings.length;
		}

		if (!invariant.passed) {
			restoreSnapshot(input.config, snapshot);
			stats.invariant_failed_hard = (stats.invariant_failed_hard ?? 0) + 1;
			// The drain rolled back: nothing landed on disk, so the truthful
			// top-level status is "skip" (paired with hard-fail diagnostics
			// in invariantHardFailures and incrementRetryOnFailure=true so the
			// batch processor can route the rows to markFailed).
			baseResult.status = "skip";
			baseResult.tier = tier;
			baseResult.escalatedFromTier = escalatedFrom;
			baseResult.error = invariant.hardFailures.map((f) => `${f.check}: ${f.message}`).join("; ");
			baseResult.incrementRetryOnFailure = true;
			cleanupStaging(batchPath);
			baseResult.durationMs = Date.now() - startedAt;
			return baseResult;
		}

		// Commit: build version changes, write version, append evolution log.
		const sessionIds = input.batch.map((q) => q.session_summary.session_id);
		const rationale = `drain=${drainId} sessions=${sessionIds.length}`;
		const changes: VersionChange[] = buildVersionChanges(
			snapshot,
			postSnapshot,
			effectiveSentinel,
			sessionIds,
			rationale,
		);

		if (changes.length === 0) {
			// Subprocess said ok but actually wrote nothing. Treat as skip.
			stats.status_skip = (stats.status_skip ?? 0) + 1;
			cleanupStaging(batchPath);
			baseResult.status = "skip";
			baseResult.tier = tier;
			baseResult.escalatedFromTier = escalatedFrom;
			baseResult.durationMs = Date.now() - startedAt;
			return baseResult;
		}

		const nextVersion = createNextVersion(snapshot.version, changes, snapshot.version.metrics_at_change);
		writeVersion(input.config, nextVersion);
		appendEvolutionLog(input.config, {
			timestamp: new Date().toISOString(),
			version: nextVersion.version,
			drain_id: drainId,
			session_ids: sessionIds,
			tier,
			status: effectiveSentinel.status,
			changes_applied: changes.length,
			details: changes,
		});
		bumpFilesTouched(stats, changes);
		stats.status_ok = (stats.status_ok ?? 0) + 1;
		if (changes.some((c) => c.type === "compact")) {
			stats.compactions_performed = (stats.compactions_performed ?? 0) + 1;
		}

		cleanupStaging(batchPath);
		// Best-effort cleanup of any unrelated files the subprocess left in
		// .staging/. This is the I9 invariant.
		pruneStaging(input.config, batchPath);

		baseResult.status = effectiveSentinel.status;
		baseResult.tier = tier;
		baseResult.escalatedFromTier = escalatedFrom;
		baseResult.version = nextVersion.version;
		baseResult.changes = changes;
		baseResult.durationMs = Date.now() - startedAt;
		return baseResult;
	};

	try {
		return await runTier("haiku", null);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		try {
			restoreSnapshot(input.config, snapshot);
		} catch {
			// swallow: the caller will see the error and rows stay in queue.
		}
		cleanupStaging(batchPath);
		baseResult.error = msg;
		baseResult.incrementRetryOnFailure = false;
		baseResult.durationMs = Date.now() - startedAt;
		return baseResult;
	}
}

function writeStagingBatch(config: EvolutionConfig, drainId: string, batch: QueuedSession[]): string {
	const stagingDir = join(config.paths.config_dir, ".staging");
	if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true });
	const filePath = join(stagingDir, `${drainId}.jsonl`);
	const body = batch
		.map((q) =>
			JSON.stringify({
				...q.session_summary,
				gate_source: q.gate_decision.source,
				gate_reason: q.gate_decision.reason,
			}),
		)
		.join("\n");
	writeFileSync(filePath, `${body}\n`, "utf-8");
	return filePath;
}

function cleanupStaging(filePath: string): void {
	try {
		if (existsSync(filePath)) unlinkSync(filePath);
	} catch {
		// Best effort: not load-bearing. I9 in the invariant check is the
		// authoritative cleanup.
	}
}

function pruneStaging(config: EvolutionConfig, currentBatchFile: string): void {
	const stagingDir = join(config.paths.config_dir, ".staging");
	if (!existsSync(stagingDir)) return;
	try {
		for (const entry of readdirSync(stagingDir)) {
			const abs = join(stagingDir, entry);
			if (abs === currentBatchFile) continue;
			try {
				unlinkSync(abs);
			} catch {
				// ignore
			}
		}
	} catch {
		// ignore
	}
}

function appendEvolutionLog(config: EvolutionConfig, entry: EvolutionLogEntry): void {
	const logPath = config.paths.evolution_log;
	try {
		const dir = dirname(logPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf-8");
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to append evolution log: ${msg}`);
	}
}

/**
 * Permissive sentinel parser. The prompt asks for a single-line JSON
 * object at the end of the final assistant message; we accept any JSON
 * object anywhere in the text and take the LAST one if there are several.
 * Returns null on failure so the caller can apply the Phase 3 failure mode
 * case 9 policy (graceful degradation to status:"ok").
 */
export function parseSentinel(text: string): SubprocessSentinel | null {
	if (!text || text.trim().length === 0) return null;
	// Find the last JSON-object-shaped substring. This is intentionally
	// permissive: agents sometimes wrap the sentinel in prose or markdown.
	const matches: Array<{ start: number; end: number }> = [];
	let depth = 0;
	let start = -1;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") {
			if (depth === 0) start = i;
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0 && start >= 0) {
				matches.push({ start, end: i + 1 });
				start = -1;
			}
			if (depth < 0) depth = 0;
		}
	}
	for (let i = matches.length - 1; i >= 0; i--) {
		const slice = text.slice(matches[i].start, matches[i].end);
		try {
			const parsed: unknown = JSON.parse(slice);
			if (isSentinelShape(parsed)) return parsed;
		} catch {
			// try previous match
		}
	}
	return null;
}

function isSentinelShape(value: unknown): value is SubprocessSentinel {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	const status = v.status;
	if (status !== "ok" && status !== "skip" && status !== "escalate") return false;
	return true;
}

function nextEscalationTier(current: ReflectionTier, requested: ReflectionTier | null): ReflectionTier | null {
	if (current === "haiku") {
		if (requested === "sonnet" || requested === "opus" || requested === null) return requested ?? "sonnet";
		return null;
	}
	if (current === "sonnet") {
		if (requested === "opus" || requested === null) return "opus";
		return null;
	}
	// Opus cannot escalate further.
	return null;
}

function directoryChanged(snapshot: DirectorySnapshot, config: EvolutionConfig): boolean {
	const current = snapshotDirectory(config);
	if (current.files.size !== snapshot.files.size) return true;
	for (const [k, v] of snapshot.files) {
		if (current.files.get(k) !== v) return true;
	}
	return false;
}

function computeFileSizes(snapshot: DirectorySnapshot): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [rel, content] of snapshot.files) {
		if (rel.startsWith("meta/") || rel.startsWith(".staging/")) continue;
		out[rel] = content === "" ? 0 : content.split("\n").length;
	}
	return out;
}

function addCost(stats: Partial<ReflectionStats>, cost: number): void {
	stats.total_cost_usd = (stats.total_cost_usd ?? 0) + cost;
}

function bumpTierStat(stats: Partial<ReflectionStats>, tier: ReflectionTier): void {
	if (tier === "haiku") stats.stage_haiku_runs = (stats.stage_haiku_runs ?? 0) + 1;
	else if (tier === "sonnet") stats.stage_sonnet_runs = (stats.stage_sonnet_runs ?? 0) + 1;
	else stats.stage_opus_runs = (stats.stage_opus_runs ?? 0) + 1;
}

function bumpTimeout(stats: Partial<ReflectionStats>, tier: ReflectionTier): void {
	if (tier === "haiku") stats.timeout_haiku = (stats.timeout_haiku ?? 0) + 1;
	else if (tier === "sonnet") stats.timeout_sonnet = (stats.timeout_sonnet ?? 0) + 1;
	else stats.timeout_opus = (stats.timeout_opus ?? 0) + 1;
}

function bumpEscalation(stats: Partial<ReflectionStats>, from: ReflectionTier, to: ReflectionTier): void {
	if (from === "haiku" && to === "sonnet") {
		stats.escalation_haiku_to_sonnet = (stats.escalation_haiku_to_sonnet ?? 0) + 1;
	} else if (from === "haiku" && to === "opus") {
		stats.escalation_haiku_to_sonnet = (stats.escalation_haiku_to_sonnet ?? 0) + 1;
		stats.escalation_sonnet_to_opus = (stats.escalation_sonnet_to_opus ?? 0) + 1;
	} else if (from === "sonnet" && to === "opus") {
		stats.escalation_sonnet_to_opus = (stats.escalation_sonnet_to_opus ?? 0) + 1;
	}
}

function bumpFilesTouched(stats: Partial<ReflectionStats>, changes: VersionChange[]): void {
	if (!stats.files_touched) stats.files_touched = {};
	for (const c of changes) {
		stats.files_touched[c.file] = (stats.files_touched[c.file] ?? 0) + 1;
	}
}

/**
 * Default production runner: spawns the Agent SDK `query()` subprocess with
 * the reflection sandbox. Builds the SDK options object, streams messages,
 * captures the final assistant text, converts abort reasons to timeout
 * signals, and returns a normalised SpawnQueryResult.
 */
async function defaultRunner(input: SpawnQueryInput): Promise<SpawnQueryResult> {
	const { tier, drainId, config, phantomConfig, systemPrompt, abortSignal } = input;
	const root = config.paths.config_dir;
	const providerEnv = phantomConfig ? buildProviderEnv(phantomConfig) : {};
	const model = TIER_MODELS[tier];

	// Permission rules are anchored at cwd. Read-wide, write-narrow: the
	// subprocess can read everything inside phantom-config (except meta and
	// agent-notes), but can only Write or Edit the canonical memory files.
	const allow: string[] = [
		"Read(./constitution.md)",
		"Read(./persona.md)",
		"Read(./user-profile.md)",
		"Read(./domain-knowledge.md)",
		"Read(./strategies/**)",
		"Read(./memory/corrections.md)",
		"Read(./memory/principles.md)",
		"Read(./memory/session-log.jsonl)",
		"Read(./memory/agent-notes.md)",
		"Read(./.staging/**)",
		"Write(./persona.md)",
		"Edit(./persona.md)",
		"Write(./user-profile.md)",
		"Edit(./user-profile.md)",
		"Write(./domain-knowledge.md)",
		"Edit(./domain-knowledge.md)",
		"Write(./strategies/**)",
		"Edit(./strategies/**)",
		"Write(./memory/corrections.md)",
		"Edit(./memory/corrections.md)",
		"Write(./memory/principles.md)",
		"Edit(./memory/principles.md)",
	];
	const deny: string[] = [
		"Write(./constitution.md)",
		"Edit(./constitution.md)",
		"Write(./memory/agent-notes.md)",
		"Edit(./memory/agent-notes.md)",
		"Write(./memory/session-log.jsonl)",
		"Edit(./memory/session-log.jsonl)",
		"Write(./meta/**)",
		"Edit(./meta/**)",
		"Read(./meta/**)",
	];

	// The SDK is invoked with `tools` as a plain allowlist so no other
	// built-in tools (Bash, Task, WebFetch) are available. The systemPrompt
	// is a plain string (no preset envelope) so the subprocess sees only
	// the reflection teaching prompt, not the Claude Code base prompt.

	const controller = new AbortController();
	const forwardAbort = (): void => controller.abort();
	if (abortSignal.aborted) controller.abort();
	else abortSignal.addEventListener("abort", forwardAbort);

	let responseText = "";
	let costUsd = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let gotResult = false;
	let errored: string | null = null;

	try {
		const stream = query({
			prompt: `Read ./.staging/${drainId}.jsonl and manage memory. Follow the teaching prompt. End with a sentinel.`,
			options: {
				model,
				cwd: root,
				additionalDirectories: [],
				permissionMode: "bypassPermissions",
				allowDangerouslySkipPermissions: true,
				tools: ["Read", "Write", "Edit", "Glob", "Grep"],
				systemPrompt,
				settings: {
					permissions: { allow, deny },
				},
				settingSources: [],
				abortController: controller,
				env: { ...process.env, ...providerEnv },
			},
		});
		for await (const message of stream) {
			if (message.type === "assistant") {
				const betaMessage = (message as { message?: { content?: unknown; usage?: unknown } }).message;
				if (betaMessage) {
					const content = extractText(betaMessage.content);
					if (content) responseText = content;
				}
			} else if (message.type === "result") {
				const m = message as {
					subtype: string;
					result?: string;
					total_cost_usd?: number;
					usage?: { input_tokens?: number; output_tokens?: number };
				};
				if (m.subtype === "success" && m.result) responseText = m.result;
				if (m.subtype !== "success") errored = m.subtype;
				costUsd = m.total_cost_usd ?? 0;
				inputTokens = m.usage?.input_tokens ?? 0;
				outputTokens = m.usage?.output_tokens ?? 0;
				gotResult = true;
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			responseText,
			costUsd,
			inputTokens,
			outputTokens,
			timedOut: abortSignal.aborted,
			sigkilled: !abortSignal.aborted,
			error: msg,
		};
	} finally {
		abortSignal.removeEventListener("abort", forwardAbort);
	}

	if (!gotResult) {
		return {
			responseText,
			costUsd,
			inputTokens,
			outputTokens,
			timedOut: abortSignal.aborted,
			sigkilled: !abortSignal.aborted,
			error: "subprocess ended without result frame",
		};
	}

	return {
		responseText,
		costUsd,
		inputTokens,
		outputTokens,
		timedOut: false,
		sigkilled: false,
		error: errored,
	};
}

function extractText(content: unknown): string | null {
	if (!content) return null;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const parts: string[] = [];
		for (const block of content) {
			if (
				block &&
				typeof block === "object" &&
				"text" in block &&
				typeof (block as { text: unknown }).text === "string"
			) {
				parts.push((block as { text: string }).text);
			}
		}
		return parts.join("\n") || null;
	}
	return null;
}
