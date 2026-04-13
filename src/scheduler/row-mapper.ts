import { parseScheduleValue } from "./schedule.ts";
import type { JobRow, ScheduledJob } from "./types.ts";

/**
 * Map a raw scheduled_jobs row to the ScheduledJob shape the rest of the
 * codebase consumes. Throws on unknown schedule_kind; callers in service.ts
 * catch and log so a single corrupt row cannot brick the whole list.
 */
export function rowToJob(row: JobRow): ScheduledJob {
	const schedule = parseScheduleValue(row.schedule_kind, row.schedule_value);
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		enabled: row.enabled === 1,
		schedule,
		task: row.task,
		delivery: {
			channel: row.delivery_channel as "slack" | "none",
			target: row.delivery_target,
		},
		status: row.status as ScheduledJob["status"],
		lastRunAt: row.last_run_at,
		lastRunStatus: row.last_run_status as ScheduledJob["lastRunStatus"],
		lastRunDurationMs: row.last_run_duration_ms,
		lastRunError: row.last_run_error,
		lastDeliveryStatus: row.last_delivery_status,
		nextRunAt: row.next_run_at,
		runCount: row.run_count,
		consecutiveErrors: row.consecutive_errors,
		deleteAfterRun: row.delete_after_run === 1,
		createdAt: row.created_at,
		createdBy: row.created_by,
		updatedAt: row.updated_at,
	};
}
