import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { AgentRuntime, RuntimeEvent } from "../agent/runtime.ts";
import type { SlackChannel } from "../channels/slack.ts";
import { buildSafeEnv } from "../mcp/dynamic-handlers.ts";
import type { MemoryContextBuilder } from "../memory/context-builder.ts";
import { runCritiqueJudge } from "./critique.ts";
import { LoopNotifier } from "./notifications.ts";
import {
	type LoopTranscript,
	type PostLoopDeps,
	clamp,
	recordTranscript,
	runPostLoopPipeline,
	synthesizeSessionData,
} from "./post-loop.ts";
import { buildTickPrompt } from "./prompt.ts";
import { initStateFile, parseFrontmatter, readStateFile } from "./state-file.ts";
import { LoopStore } from "./store.ts";
import {
	LOOP_DEFAULT_MAX_COST_USD,
	LOOP_DEFAULT_MAX_ITERATIONS,
	LOOP_DEFAULT_MAX_TICK_DURATION_MS,
	LOOP_MAX_COST_CEILING_USD,
	LOOP_MAX_ITERATIONS_CEILING,
	type Loop,
	type LoopStartInput,
	type LoopStatus,
} from "./types.ts";

/** Narrowed runtime interface for testability. */
type LoopRuntime = Pick<AgentRuntime, "handleMessage" | "releaseSession">;

type RunnerDeps = {
	db: Database;
	runtime: LoopRuntime;
	slackChannel?: SlackChannel;
	dataDir?: string;
	memoryContextBuilder?: MemoryContextBuilder;
	postLoopDeps?: PostLoopDeps;
	/** Tests set to false to drive ticks deterministically. */
	autoSchedule?: boolean;
	/** Extra grace window after the soft abort before the hard cancel fires. */
	hardCancelGraceMs?: number;
};

const SUCCESS_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_HARD_CANCEL_GRACE_MS = 30 * 1000;

/** start -> tick (N times) -> finalize. State file is the agent's memory across ticks. */
export class LoopRunner {
	private store: LoopStore;
	private runtime: LoopRuntime;
	private slackChannel: SlackChannel | undefined;
	private dataDir: string;
	private autoSchedule: boolean;
	private hardCancelGraceMs: number;
	private inFlight = new Set<string>();
	private notifier: LoopNotifier;
	private memoryContextBuilder: MemoryContextBuilder | undefined;
	private postLoopDeps: PostLoopDeps | undefined;
	private memoryCache = new Map<string, string>();
	private transcripts = new Map<string, LoopTranscript>();
	private pendingCritique = new Map<string, string>();

	constructor(deps: RunnerDeps) {
		this.store = new LoopStore(deps.db);
		this.runtime = deps.runtime;
		this.slackChannel = deps.slackChannel;
		this.dataDir = deps.dataDir ?? resolve(process.cwd(), "data");
		this.autoSchedule = deps.autoSchedule ?? true;
		this.hardCancelGraceMs = deps.hardCancelGraceMs ?? DEFAULT_HARD_CANCEL_GRACE_MS;
		this.notifier = new LoopNotifier(this.slackChannel ?? null, this.store);
		this.memoryContextBuilder = deps.memoryContextBuilder;
		this.postLoopDeps = deps.postLoopDeps;
	}

	setSlackChannel(channel: SlackChannel): void {
		this.slackChannel = channel;
		this.notifier = new LoopNotifier(channel, this.store);
	}

	private assertWorkspaceInsideDataDir(workspace: string): string {
		const base = resolve(this.dataDir);
		const target = resolve(base, workspace);
		const rel = relative(base, target);
		if (rel.startsWith("..") || rel.includes("..")) {
			throw new Error(`workspace path escapes data dir: ${workspace}`);
		}
		return target;
	}

	start(input: LoopStartInput): Loop {
		const id = randomUUID();
		const workspaceDir = input.workspace
			? this.assertWorkspaceInsideDataDir(input.workspace)
			: join(this.dataDir, "loops", id);
		const stateFile = join(workspaceDir, "state.md");

		const maxIterations = clamp(input.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS, 1, LOOP_MAX_ITERATIONS_CEILING);
		const maxCostUsd = clamp(input.maxCostUsd ?? LOOP_DEFAULT_MAX_COST_USD, 0.01, LOOP_MAX_COST_CEILING_USD);
		// maxTickDurationMs is trusted from the caller: the tool boundary (Zod
		// in tool.ts) enforces the 1-60 minute window. Tests need to pass very
		// small values to exercise the timeout path without sleeping a minute,
		// so clamping here would force an awkward test-only override.
		const maxTickDurationMs = input.maxTickDurationMs ?? LOOP_DEFAULT_MAX_TICK_DURATION_MS;

		initStateFile(stateFile, id, input.goal);

		const loop = this.store.insert({
			id,
			goal: input.goal,
			workspaceDir,
			stateFile,
			successCommand: input.successCommand ?? null,
			maxIterations,
			maxCostUsd,
			maxTickDurationMs,
			checkpointInterval: input.checkpointInterval ?? null,
			channelId: input.channelId ?? null,
			conversationId: input.conversationId ?? null,
			triggerMessageTs: input.triggerMessageTs ?? null,
		});

		this.notifier.postStartNotice(loop).catch((e: unknown) => {
			console.warn(`[loop] Failed to post start notice for ${id}: ${e instanceof Error ? e.message : e}`);
		});

		// Cache memory context once for the entire loop (goal is constant)
		this.cacheMemoryContext(id, input.goal);

		this.scheduleTick(id);
		return loop;
	}

	getLoop(id: string): Loop | null {
		return this.store.findById(id);
	}

	list(includeFinished: boolean): Loop[] {
		return this.store.listAll(includeFinished);
	}

	requestStop(id: string): boolean {
		return this.store.requestStop(id);
	}

	resumeRunning(): number {
		const running = this.store.listByStatus("running");
		for (const loop of running) {
			console.log(`[loop] Resuming ${loop.id} (iteration ${loop.iterationCount})`);
			this.cacheMemoryContext(loop.id, loop.goal);
			this.scheduleTick(loop.id);
		}
		return running.length;
	}

	private scheduleTick(id: string): void {
		if (!this.autoSchedule) return;
		setImmediate(() => {
			this.tick(id).catch((e: unknown) => {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`[loop] Tick ${id} threw: ${msg}`);
				this.finalize(id, "failed", msg);
			});
		});
	}

	async tick(id: string): Promise<void> {
		if (this.inFlight.has(id)) return;
		this.inFlight.add(id);
		try {
			const loop = this.store.findById(id);
			if (!loop || loop.status !== "running") return;

			if (loop.interruptRequested) {
				this.finalize(id, "stopped", null);
				return;
			}

			if (loop.iterationCount >= loop.maxIterations || loop.totalCostUsd >= loop.maxCostUsd) {
				this.finalize(id, "budget_exceeded", null);
				return;
			}

			const stateFileContents = readStateFile(loop.stateFile);
			const memoryContext = this.memoryCache.get(id);
			const critique = this.pendingCritique.get(id);
			if (critique) this.pendingCritique.delete(id);
			const prompt = buildTickPrompt(loop, stateFileContents, {
				memoryContext,
				critique,
			});

			const conversationId = `${loop.id}:${loop.iterationCount}`;

			// Two-layer cancel. The soft abort gives the SDK a chance to clean
			// up cooperatively; the hard race is the escape hatch for wedged
			// subprocesses (notably `docker exec` swallowing signals).
			const tickController = new AbortController();
			let softTimerFired = false;
			let lastTool: string | null = null;
			const tickStartMs = Date.now();

			const onEvent = (e: RuntimeEvent): void => {
				if (e.type === "tool_use") lastTool = e.tool;
			};

			const softTimer = setTimeout(() => {
				softTimerFired = true;
				tickController.abort();
			}, loop.maxTickDurationMs);

			const hardTimeoutMs = loop.maxTickDurationMs + this.hardCancelGraceMs;
			let hardTimer: ReturnType<typeof setTimeout> | undefined;
			const hardTimeout = new Promise<never>((_, reject) => {
				hardTimer = setTimeout(() => {
					reject(new Error(`HARD_TIMEOUT after ${hardTimeoutMs}ms (lastTool=${lastTool ?? "none"})`));
				}, hardTimeoutMs);
			});

			const messagePromise = this.runtime.handleMessage("loop", conversationId, prompt, onEvent, tickController.signal);
			// If the hard-timeout wins the race, messagePromise is left dangling
			// and a later rejection from it would become an unhandled rejection.
			// Attach a no-op catch handler now; Promise.race below still sees the
			// original rejection because it registered its own handler too.
			messagePromise.catch(() => {});

			let response: Awaited<ReturnType<LoopRuntime["handleMessage"]>> | null = null;
			let raceError: unknown = null;
			try {
				response = (await Promise.race([messagePromise, hardTimeout])) as Awaited<
					ReturnType<LoopRuntime["handleMessage"]>
				>;
			} catch (e: unknown) {
				raceError = e;
			}
			clearTimeout(softTimer);
			if (hardTimer) clearTimeout(hardTimer);

			const raceMsg = raceError instanceof Error ? raceError.message : raceError ? String(raceError) : "";
			const hardTimedOut = raceMsg.startsWith("HARD_TIMEOUT");

			// softTimerFired guards the case where the SDK aborted cooperatively
			// and returned a normal-looking response with an error-text body. The
			// race resolves without throwing, so we must check the flag even on
			// the success path — otherwise we'd call recordTick + re-read the
			// state file on a tick that actually timed out.
			if (softTimerFired || hardTimedOut) {
				// A hard cancel means the orphan handleMessage promise will never
				// resolve, so its own finally block will never drop the
				// activeSessions entry. Release it here so subsequent ticks on
				// the same conversation id can proceed. The soft path doesn't
				// need this: the SDK already returned and its finally ran.
				if (hardTimedOut) {
					this.runtime.releaseSession("loop", conversationId);
				}
				const elapsedMs = Date.now() - tickStartMs;
				const kind = hardTimedOut ? "hard" : "soft";
				const detail = `Tick ${kind}-timed-out after ${elapsedMs}ms (limit ${loop.maxTickDurationMs}ms, lastTool=${lastTool ?? "none"})`;
				this.finalize(id, "timed_out", detail);
				return;
			}

			if (raceError) {
				// Unrelated SDK failure: rethrow so scheduleTick's catch routes
				// it to finalize(..., "failed", ...).
				throw raceError;
			}

			// Control-flow invariant: reaching this point means the race resolved
			// successfully (no throw, no timeout), so `response` is non-null.
			const resolvedResponse = response as NonNullable<typeof response>;
			const addedCost = resolvedResponse.cost.totalUsd;
			const nextIteration = loop.iterationCount + 1;
			this.store.recordTick(id, nextIteration, addedCost);

			// Re-read state file to learn what the agent wants to do next.
			const updatedContents = readStateFile(loop.stateFile);
			const frontmatter = parseFrontmatter(updatedContents);

			// Track bounded transcript for post-loop evolution
			recordTranscript(this.transcripts, id, nextIteration, prompt, resolvedResponse.text, frontmatter?.status);

			if (frontmatter?.status === "done") {
				this.finalize(id, "done", null);
				return;
			}

			if (loop.successCommand) {
				const passed = await this.runSuccessCommand(loop);
				if (passed) {
					this.finalize(id, "done", null);
					return;
				}
			}

			// Mid-loop critique checkpoint (Sonnet reviewing Opus mid-flight).
			// Runs after terminal checks so we don't waste a judge call on the final tick.
			if (loop.checkpointInterval && loop.checkpointInterval > 0 && nextIteration % loop.checkpointInterval === 0) {
				await this.runCritique(id, loop, updatedContents, nextIteration);
			}

			// Await tick update so its Slack write finishes before the next tick
			try {
				await this.notifier.postTickUpdate(id, nextIteration, frontmatter?.status ?? "in-progress");
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[loop] Failed to post tick update for ${id}: ${msg}`);
			}

			this.scheduleTick(id);
		} finally {
			this.inFlight.delete(id);
		}
	}

	private async runSuccessCommand(loop: Loop): Promise<boolean> {
		if (!loop.successCommand) return false;
		const proc = Bun.spawn(["bash", "-c", loop.successCommand], {
			stdout: "pipe",
			stderr: "pipe",
			env: buildSafeEnv({ loop_id: loop.id, workspace: loop.workspaceDir }),
		});

		const timer = setTimeout(() => proc.kill(), SUCCESS_COMMAND_TIMEOUT_MS);
		try {
			await proc.exited;
		} finally {
			clearTimeout(timer);
		}
		return proc.exitCode === 0;
	}

	private finalize(id: string, status: LoopStatus, error: string | null): void {
		const transcript = this.transcripts.get(id);
		this.memoryCache.delete(id);
		this.transcripts.delete(id);
		this.pendingCritique.delete(id);
		const loop = this.store.finalize(id, status, error);
		if (!loop) return;
		this.notifier.postFinalNotice(loop, status).catch((e: unknown) => {
			console.warn(`[loop] Failed to post final notice for ${id}: ${e instanceof Error ? e.message : e}`);
		});

		// Post-loop evolution and consolidation (fire-and-forget, never affects loop status)
		if (this.postLoopDeps && transcript) {
			runPostLoopPipeline(this.postLoopDeps, synthesizeSessionData(loop, status, transcript)).catch((e: unknown) => {
				console.warn(`[loop] Post-loop evolution failed for ${id}: ${e instanceof Error ? e.message : e}`);
			});
		}
	}

	private async runCritique(loopId: string, loop: Loop, stateContents: string, iteration: number): Promise<void> {
		const transcript = this.transcripts.get(loopId);
		if (!transcript) return;
		const evo = this.postLoopDeps?.evolution;
		if (!evo || !evo.usesLLMJudges() || !evo.isWithinCostCap()) return;
		try {
			const r = await runCritiqueJudge(loop.goal, stateContents, transcript, iteration, loop.maxIterations);
			this.pendingCritique.set(loopId, r.assessment);
			evo.trackExternalJudgeCost(r.cost);
		} catch (e: unknown) {
			console.warn(`[loop] Critique failed for ${loopId}: ${e instanceof Error ? e.message : e}`);
		}
	}

	private cacheMemoryContext(loopId: string, goal: string): void {
		if (!this.memoryContextBuilder) return;
		this.memoryContextBuilder
			.build(goal)
			.then((ctx) => {
				if (ctx) this.memoryCache.set(loopId, ctx);
			})
			.catch((e: unknown) => {
				console.warn(`[loop] Memory context failed for ${loopId}: ${e instanceof Error ? e.message : e}`);
			});
	}
}
