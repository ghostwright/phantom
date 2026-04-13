import type { Database } from "bun:sqlite";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { SlackChannel } from "../channels/slack.ts";
import { type DeliveryOutcome, deliverResult } from "./delivery.ts";
import { computeBackoffNextRun, computeNextRunAt } from "./schedule.ts";
import { JOB_STATUS_VALUES, type ScheduledJob } from "./types.ts";

export const MAX_CONSECUTIVE_ERRORS = 10;

export type ExecutorContext = {
	db: Database;
	runtime: AgentRuntime;
	slackChannel: SlackChannel | undefined;
	ownerUserId: string | null;
	notifyOwner: (text: string) => void;
};

/**
 * Run a single scheduled job end to end: runtime call, schedule advance,
 * delivery, row update, optional deletion. Every exit path writes a status
 * and a delivery outcome so operators see what happened.
 */
export async function executeJob(job: ScheduledJob, ctx: ExecutorContext): Promise<string> {
	// C2 braces layer: if the runtime is already executing this job's session,
	// skip the fire without touching any job state. The timer will retry at
	// its next wake-up. Do not increment run_count, consecutive_errors, or
	// advance next_run_at: the fire never happened.
	if (ctx.runtime.isSessionBusy("scheduler", `sched:${job.id}`)) {
		console.warn(
			`[scheduler] Skipping fire for "${job.name}" (${job.id}): previous execution still running. The next scheduled fire will retry.`,
		);
		return "";
	}

	const startMs = Date.now();
	console.log(`[scheduler] Executing job: ${job.name} (${job.id})`);

	let responseText = "";
	let runStatus: "ok" | "error" = "ok";
	let errorMsg: string | null = null;

	try {
		const response = await ctx.runtime.handleMessage("scheduler", `sched:${job.id}`, job.task);
		responseText = response.text;
		if (responseText.startsWith("Error:")) {
			runStatus = "error";
			errorMsg = responseText;
		}
	} catch (err: unknown) {
		runStatus = "error";
		errorMsg = err instanceof Error ? err.message : String(err);
		responseText = `Error: ${errorMsg}`;
	}

	const durationMs = Date.now() - startMs;
	const newConsecErrors = runStatus === "error" ? job.consecutiveErrors + 1 : 0;

	let nextRunAt: string | null = null;
	let newStatus = job.status;

	if (runStatus === "ok") {
		if (job.deleteAfterRun || job.schedule.kind === "at") {
			newStatus = "completed";
		} else {
			const nextRun = computeNextRunAt(job.schedule);
			nextRunAt = nextRun?.toISOString() ?? null;
		}
	} else if (newConsecErrors >= MAX_CONSECUTIVE_ERRORS) {
		newStatus = "failed";
		ctx.notifyOwner(
			`Scheduled task "${job.name}" has failed ${MAX_CONSECUTIVE_ERRORS} times in a row and has been disabled. Last error: ${errorMsg}`,
		);
	} else if (job.schedule.kind === "at" && newConsecErrors >= 3) {
		newStatus = "failed";
	} else {
		// M6: cron jobs should reconnect to their cadence on recovery. Pick
		// min(backoff, next cron fire) so a transient failure does not drift
		// the job permanently off its schedule.
		const backoffDate = computeBackoffNextRun(newConsecErrors);
		if (job.schedule.kind === "cron") {
			const nextCronFire = computeNextRunAt(job.schedule);
			if (nextCronFire && nextCronFire.getTime() < backoffDate.getTime()) {
				nextRunAt = nextCronFire.toISOString();
			} else {
				nextRunAt = backoffDate.toISOString();
			}
		} else {
			nextRunAt = backoffDate.toISOString();
		}
	}

	// Deliver first so last_delivery_status is fresh in the UPDATE. delivery
	// never throws: it returns an outcome string. One Slack outage in a batch
	// cannot kill subsequent jobs.
	let deliveryStatus: DeliveryOutcome | null = null;
	if (runStatus === "ok" && responseText) {
		deliveryStatus = await deliverResult(job, responseText, {
			slackChannel: ctx.slackChannel,
			ownerUserId: ctx.ownerUserId,
		});
	}

	// Runtime safety net for OOS#4.
	if (!JOB_STATUS_VALUES.includes(newStatus)) {
		throw new Error(`refusing to write invalid status '${newStatus}' for job ${job.id}`);
	}

	ctx.db.run(
		`UPDATE scheduled_jobs SET
			last_run_at = ?,
			last_run_status = ?,
			last_run_duration_ms = ?,
			last_run_error = ?,
			last_delivery_status = COALESCE(?, last_delivery_status),
			next_run_at = ?,
			run_count = run_count + 1,
			consecutive_errors = ?,
			status = ?,
			updated_at = datetime('now')
		WHERE id = ?`,
		[
			new Date(startMs).toISOString(),
			runStatus,
			durationMs,
			errorMsg,
			deliveryStatus,
			nextRunAt,
			newConsecErrors,
			newStatus,
			job.id,
		],
	);

	if (newStatus === "completed" && job.deleteAfterRun) {
		ctx.db.run("DELETE FROM scheduled_jobs WHERE id = ?", [job.id]);
	}

	return responseText;
}
