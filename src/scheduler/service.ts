import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { SlackChannel } from "../channels/slack.ts";
import { validateCreateInput } from "./create-validation.ts";
import { executeJob } from "./executor.ts";
import { type SchedulerHealthSummary, computeHealthSummary } from "./health.ts";
import { cleanupOldTerminalJobs, staggerMissedJobs } from "./recovery.ts";
import { rowToJob } from "./row-mapper.ts";
import { computeNextRunAt, serializeScheduleValue } from "./schedule.ts";
import type { JobCreateInput, JobRow, ScheduledJob } from "./types.ts";

// Upper bound on the setTimeout delay we pass when arming the next wake-up.
// Both Node and Bun use a 32-bit signed integer for the setTimeout delay, so
// any value above 2^31-1 ms (roughly 24.8 days) silently coerces to about one
// millisecond, which would turn armTimer -> onTimer -> armTimer into a hot
// spin loop for any job whose next fire is more than a few weeks out (long
// at-schedules, cron expressions whose next firing is far in the future,
// every-schedules with large intervals). One hour gives us a ~600x safety
// margin under the overflow boundary while keeping the idle re-arm cost to
// one indexed SQL MIN query per hour, which is effectively free.
const MAX_TIMER_MS = 60 * 60 * 1000;

type SchedulerDeps = {
	db: Database;
	runtime: AgentRuntime;
	slackChannel?: SlackChannel;
	ownerUserId?: string | null;
};

export class Scheduler {
	private db: Database;
	private runtime: AgentRuntime;
	private slackChannel: SlackChannel | undefined;
	private ownerUserId: string | null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private executing = false;

	constructor(deps: SchedulerDeps) {
		this.db = deps.db;
		this.runtime = deps.runtime;
		this.slackChannel = deps.slackChannel;
		this.ownerUserId = deps.ownerUserId ?? null;
	}

	/**
	 * Inject the Slack channel after construction. ownerUserId may be null
	 * (C3): owner-targeted delivery is skipped until ownerUserId is set, but
	 * channel-id (C...) and user-id (U...) targets work immediately.
	 */
	setSlackChannel(channel: SlackChannel, ownerUserId: string | null): void {
		this.slackChannel = channel;
		this.ownerUserId = ownerUserId ?? null;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		// Non-blocking recovery (M1): rewrite next_run_at on past-due rows and
		// let the normal onTimer loop pick them up in sequence. start() returns
		// in milliseconds instead of blocking boot for minutes.
		staggerMissedJobs(this.db);
		cleanupOldTerminalJobs(this.db);
		this.armTimer();
		console.log("[scheduler] Started");
	}

	stop(): void {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		console.log("[scheduler] Stopped");
	}

	isRunning(): boolean {
		return this.running;
	}

	createJob(input: JobCreateInput): ScheduledJob {
		// All creation validation lives in one place so the failure modes are
		// obvious and the happy path in this method stays small. See C1, C4,
		// N1, N8, OOS#6.
		const delivery = validateCreateInput(this.db, input);

		const id = randomUUID();
		const scheduleValue = serializeScheduleValue(input.schedule);
		const nextRun = computeNextRunAt(input.schedule);
		if (!nextRun) {
			throw new Error("invalid schedule: validator passed but computeNextRunAt returned null");
		}

		this.db.run(
			`INSERT INTO scheduled_jobs (id, name, description, schedule_kind, schedule_value, task, delivery_channel, delivery_target, next_run_at, delete_after_run, created_by)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.name,
				input.description ?? null,
				input.schedule.kind,
				scheduleValue,
				input.task,
				delivery.channel,
				delivery.target,
				nextRun.toISOString(),
				input.deleteAfterRun ? 1 : 0,
				input.createdBy ?? "agent",
			],
		);

		this.armTimer();

		const created = this.getJob(id);
		if (!created) throw new Error(`failed to create job: ${id}`);
		return created;
	}

	deleteJob(id: string): boolean {
		const result = this.db.run("DELETE FROM scheduled_jobs WHERE id = ?", [id]);
		if (result.changes > 0) {
			this.armTimer();
			return true;
		}
		return false;
	}

	/**
	 * Defensive read: one corrupt row (a future kind, a truncated write) must
	 * not brick the whole list. Bad rows are logged and skipped. See M8.
	 */
	listJobs(): ScheduledJob[] {
		const rows = this.db.query("SELECT * FROM scheduled_jobs ORDER BY created_at DESC").all() as JobRow[];
		const jobs: ScheduledJob[] = [];
		for (const row of rows) {
			try {
				jobs.push(rowToJob(row));
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[scheduler] Failed to parse row ${row.id} (${row.name ?? "?"}): ${msg}`);
			}
		}
		return jobs;
	}

	getJob(id: string): ScheduledJob | null {
		const row = this.db.query("SELECT * FROM scheduled_jobs WHERE id = ?").get(id) as JobRow | null;
		if (!row) return null;
		try {
			return rowToJob(row);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[scheduler] Failed to parse row ${row.id}: ${msg}`);
			return null;
		}
	}

	findJobIdByName(name: string | undefined): string | undefined {
		if (!name) return undefined;
		const lowerName = name.toLowerCase();
		for (const job of this.listJobs()) {
			if (job.name.toLowerCase() === lowerName) return job.id;
		}
		return undefined;
	}

	/**
	 * Manual trigger. Respects the single-slot onTimer guard (M2) and the
	 * job status gate (M9). An admin override cannot resurrect a failed job.
	 */
	async runJobNow(id: string): Promise<string> {
		if (this.executing) {
			throw new Error("scheduler is currently executing another job, try again shortly");
		}
		const job = this.getJob(id);
		if (!job) throw new Error(`Job not found: ${id}`);
		if (!job.enabled) throw new Error(`Job is disabled: ${id}`);
		if (job.status !== "active") {
			throw new Error(`Job ${id} is in status '${job.status}', only active jobs can be run`);
		}

		this.executing = true;
		try {
			return await this.runExecutor(job);
		} finally {
			this.executing = false;
		}
	}

	/** Minimal health snapshot for the /health endpoint (M5). */
	getHealthSummary(): SchedulerHealthSummary {
		return computeHealthSummary(this.db);
	}

	armTimer(): void {
		if (!this.running) return;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		const row = this.db
			.query(
				"SELECT MIN(next_run_at) as next FROM scheduled_jobs WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL",
			)
			.get() as { next: string | null } | null;

		if (!row?.next) return;

		// Clamp the setTimeout delay to MAX_TIMER_MS (1 hour) to avoid the
		// 32-bit overflow described on the constant: any value above ~24.8 days
		// would be coerced to roughly 1 ms and hot-loop armTimer. When the next
		// fire is within the clamp we wake at the exact fire time; otherwise
		// we wake at the clamp, re-evaluate the MIN query, and re-arm.
		const delay = Math.max(0, new Date(row.next).getTime() - Date.now());
		const clamped = Math.min(delay, MAX_TIMER_MS);
		this.timer = setTimeout(() => this.onTimer(), clamped);
	}

	private async onTimer(): Promise<void> {
		if (!this.running) return;

		if (this.executing) {
			this.armTimer();
			return;
		}

		this.executing = true;

		try {
			const now = new Date().toISOString();
			const dueRows = this.db
				.query(
					"SELECT * FROM scheduled_jobs WHERE enabled = 1 AND status = 'active' AND next_run_at <= ? ORDER BY next_run_at ASC",
				)
				.all(now) as JobRow[];

			for (const row of dueRows) {
				if (!this.running) break;
				let job: ScheduledJob;
				try {
					job = rowToJob(row);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[scheduler] Skipping unparsable row ${row.id}: ${msg}`);
					continue;
				}
				try {
					await this.runExecutor(job);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					console.error(`[scheduler] Job ${job.id} (${job.name}) failed: ${msg}`);
				}
			}
		} finally {
			this.executing = false;
			this.armTimer();
		}
	}

	private runExecutor(job: ScheduledJob): Promise<string> {
		return executeJob(job, {
			db: this.db,
			runtime: this.runtime,
			slackChannel: this.slackChannel,
			ownerUserId: this.ownerUserId,
			notifyOwner: (text: string) => this.notifyOwner(text),
		});
	}

	private notifyOwner(text: string): void {
		if (this.slackChannel && this.ownerUserId) {
			this.slackChannel.sendDm(this.ownerUserId, text).catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`[scheduler] Failed to notify owner: ${msg}`);
			});
			return;
		}
		console.error(`[scheduler] Terminal failure notify dropped (owner unset): ${text}`);
	}
}
