import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { SlackChannel } from "../channels/slack.ts";
import { buildSafeEnv } from "../mcp/dynamic-handlers.ts";
import { LoopNotifier } from "./notifications.ts";
import { buildTickPrompt } from "./prompt.ts";
import { initStateFile, parseFrontmatter, readStateFile } from "./state-file.ts";
import { LoopStore } from "./store.ts";
import {
	LOOP_DEFAULT_MAX_COST_USD,
	LOOP_DEFAULT_MAX_ITERATIONS,
	LOOP_MAX_COST_CEILING_USD,
	LOOP_MAX_ITERATIONS_CEILING,
	type Loop,
	type LoopStartInput,
	type LoopStatus,
} from "./types.ts";

/**
 * The runner only needs handleMessage from the AgentRuntime - narrowing the
 * dependency keeps the runner honest (SRP) and lets tests pass a minimal mock
 * without `as never` casts. A real AgentRuntime is assignable to this.
 */
type LoopRuntime = Pick<AgentRuntime, "handleMessage">;

type RunnerDeps = {
	db: Database;
	runtime: LoopRuntime;
	slackChannel?: SlackChannel;
	dataDir?: string;
	/**
	 * When true (default), start() and resumeRunning() schedule ticks on the
	 * event loop automatically. Tests set this to false so they can drive
	 * ticks deterministically with explicit `await runner.tick(id)` calls.
	 */
	autoSchedule?: boolean;
};

const SUCCESS_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * LoopRunner owns the lifecycle of ralph loops:
 *   start -> tick (N times) -> finalize
 *
 * Each tick is a fresh SDK session. We achieve that by passing a unique
 * conversation id per iteration to runtime.handleMessage, which keys
 * sessions on `${channelId}:${conversationId}`. No runtime changes needed.
 *
 * State lives in a markdown file. The runner only reads the YAML frontmatter
 * to decide termination - the body is the agent's working memory.
 *
 * Budgets (max_iterations, max_cost_usd) are enforced here, never trusted to
 * the agent. The agent can self-declare done (status: done) to stop early,
 * but cannot extend the loop past its budget.
 */
export class LoopRunner {
	private store: LoopStore;
	private runtime: LoopRuntime;
	private slackChannel: SlackChannel | undefined;
	private dataDir: string;
	private autoSchedule: boolean;
	private inFlight = new Set<string>();
	private notifier: LoopNotifier;

	constructor(deps: RunnerDeps) {
		this.store = new LoopStore(deps.db);
		this.runtime = deps.runtime;
		this.slackChannel = deps.slackChannel;
		this.dataDir = deps.dataDir ?? resolve(process.cwd(), "data");
		this.autoSchedule = deps.autoSchedule ?? true;
		this.notifier = new LoopNotifier(this.slackChannel ?? null, this.store);
	}

	setSlackChannel(channel: SlackChannel): void {
		this.slackChannel = channel;
		this.notifier = new LoopNotifier(channel, this.store);
	}

	/**
	 * Reject operator-supplied workspace paths that escape the data dir. The
	 * agent invokes start() via MCP, and a stray `..` could point the state
	 * file outside the sandbox. Mirrors the isPathSafe idiom in src/ui/serve.ts.
	 */
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

		initStateFile(stateFile, id, input.goal);

		const loop = this.store.insert({
			id,
			goal: input.goal,
			workspaceDir,
			stateFile,
			successCommand: input.successCommand ?? null,
			maxIterations,
			maxCostUsd,
			channelId: input.channelId ?? null,
			conversationId: input.conversationId ?? null,
			triggerMessageTs: input.triggerMessageTs ?? null,
		});

		this.notifier.postStartNotice(loop).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[loop] Failed to post start notice for ${id}: ${msg}`);
		});

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

	/** On startup, re-queue any loops still marked running. State file is the source of truth. */
	resumeRunning(): number {
		const running = this.store.listByStatus("running");
		for (const loop of running) {
			console.log(`[loop] Resuming ${loop.id} (iteration ${loop.iterationCount})`);
			this.scheduleTick(loop.id);
		}
		return running.length;
	}

	private scheduleTick(id: string): void {
		if (!this.autoSchedule) return;
		// setImmediate yields to the event loop so we never recurse on the same stack.
		setImmediate(() => {
			this.tick(id).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
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
			const prompt = buildTickPrompt(loop, stateFileContents);

			const conversationId = `${loop.id}:${loop.iterationCount}`;
			const response = await this.runtime.handleMessage("loop", conversationId, prompt);

			const addedCost = response.cost.totalUsd;
			const nextIteration = loop.iterationCount + 1;
			this.store.recordTick(id, nextIteration, addedCost);

			// Re-read state file to learn what the agent wants to do next.
			const updatedContents = readStateFile(loop.stateFile);
			const frontmatter = parseFrontmatter(updatedContents);

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

			// Await the tick update so its Slack write finishes before the next
			// tick can start (and potentially finalize). Without this, a stop on
			// tick N+1 can race: postFinalNotice strips the Stop button, then the
			// fire-and-forget postTickUpdate from tick N resolves and re-sends the
			// blocks, making the button reappear on a finalized message.
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
		const loop = this.store.finalize(id, status, error);
		if (!loop) return;
		this.notifier.postFinalNotice(loop, status).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[loop] Failed to post final notice for ${id}: ${msg}`);
		});
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
