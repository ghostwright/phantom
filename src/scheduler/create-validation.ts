import type { Database } from "bun:sqlite";
import { validateSchedule } from "./schedule.ts";
import { type JobCreateInput, type JobDelivery, isValidSlackTarget } from "./types.ts";

export const MAX_JOBS = 1_000;
export const MAX_TASK_BYTES = 32 * 1024;

/**
 * All creation-time validation for a scheduled job. Throws a descriptive
 * Error on any failure so the tool wrapper in tool.ts can surface it as
 * isError:true. Returns the resolved delivery shape (applies defaults).
 *
 * Addresses C1 (schedule), C4 (delivery target), N1 (duplicate name),
 * N8 (task size), OOS#6 (max jobs), and N9 (single canonical default layer).
 */
export function validateCreateInput(db: Database, input: JobCreateInput): JobDelivery {
	// Rate limit: cheap insurance against a runaway agent loop.
	const countRow = db.query("SELECT COUNT(*) as c FROM scheduled_jobs").get() as { c: number };
	if (countRow.c >= MAX_JOBS) {
		throw new Error(`scheduler job limit reached (${MAX_JOBS}); delete unused jobs before creating more`);
	}

	// Task text sanity check.
	const taskBytes = Buffer.byteLength(input.task, "utf8");
	if (taskBytes > MAX_TASK_BYTES) {
		throw new Error(`task text is ${taskBytes} bytes, exceeds ${MAX_TASK_BYTES} byte limit`);
	}

	// Duplicate name detection (case-insensitive to match findJobIdByName).
	const dupe = db.query("SELECT id FROM scheduled_jobs WHERE lower(name) = lower(?)").get(input.name) as {
		id: string;
	} | null;
	if (dupe) {
		throw new Error(`job with name "${input.name}" already exists (id: ${dupe.id})`);
	}

	// Schedule validation: fail fast at the boundary so the database never
	// accumulates dead-on-arrival rows with next_run_at=NULL.
	const scheduleError = validateSchedule(input.schedule);
	if (scheduleError) {
		throw new Error(`invalid schedule: ${scheduleError}`);
	}

	// Delivery target validation. Channel-id (C...) and user-id (U...) targets
	// work without owner_user_id; "owner" requires owner_user_id at runtime
	// (the runtime fallthrough branch records a dropped outcome if unset).
	// Single canonical default layer per N9.
	const delivery = input.delivery ?? { channel: "slack" as const, target: "owner" };
	if (delivery.channel === "slack" && !isValidSlackTarget(delivery.target)) {
		throw new Error(
			`invalid delivery.target '${delivery.target}': must be "owner", a Slack channel id (C...), or a Slack user id (U...)`,
		);
	}

	return delivery;
}
