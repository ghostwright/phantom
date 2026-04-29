import { z } from "zod";

export const ScheduleKindSchema = z.enum(["at", "every", "cron"]);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

export const AtScheduleSchema = z.object({
	kind: z.literal("at"),
	at: z.string().describe("ISO 8601 timestamp with explicit offset, e.g. 2026-03-26T09:00:00-07:00"),
});

export const EveryScheduleSchema = z.object({
	kind: z.literal("every"),
	intervalMs: z.number().int().positive().describe("Interval in milliseconds"),
});

export const CronScheduleSchema = z.object({
	kind: z.literal("cron"),
	expr: z
		.string()
		.describe("Standard 5-field cron: minute hour day-of-month month day-of-week. No seconds, no nicknames."),
	tz: z.string().optional().describe("IANA timezone, e.g. America/Los_Angeles"),
});

export const ScheduleSchema = z.discriminatedUnion("kind", [AtScheduleSchema, EveryScheduleSchema, CronScheduleSchema]);
export type Schedule = z.infer<typeof ScheduleSchema>;

// The JobDeliverySchema is the single canonical source of delivery defaults.
// service.createJob trusts the parsed shape and does not add a second fallback layer.
// See N9 in the Phase 2.5 scheduler audit for the rationale.
export const JobDeliverySchema = z.object({
	channel: z.enum(["slack", "none"]).default("slack"),
	target: z.string().default("owner").describe('"owner", a Slack channel id (C...), or a Slack user id (U...)'),
});
export type JobDelivery = z.infer<typeof JobDeliverySchema>;

export type JobStatus = "active" | "paused" | "completed" | "failed";
export const JOB_STATUS_VALUES: readonly JobStatus[] = ["active", "paused", "completed", "failed"] as const;
export type RunStatus = "ok" | "error" | "skipped";
export type DeliveryStatus = "delivered" | `dropped:${string}` | `error:${string}`;

export type ScheduledJob = {
	id: string;
	name: string;
	description: string | null;
	enabled: boolean;
	schedule: Schedule;
	task: string;
	delivery: JobDelivery;
	status: JobStatus;
	lastRunAt: string | null;
	lastRunStatus: RunStatus | null;
	lastRunDurationMs: number | null;
	lastRunError: string | null;
	lastDeliveryStatus: string | null;
	nextRunAt: string | null;
	runCount: number;
	consecutiveErrors: number;
	deleteAfterRun: boolean;
	createdAt: string;
	createdBy: string;
	updatedAt: string;
};

export type JobCreateInput = {
	name: string;
	description?: string;
	schedule: Schedule;
	task: string;
	delivery?: JobDelivery;
	deleteAfterRun?: boolean;
	enabled?: boolean;
	createdBy?: string;
};

export type JobRow = {
	id: string;
	name: string;
	description: string | null;
	enabled: number;
	schedule_kind: string;
	schedule_value: string;
	task: string;
	delivery_channel: string;
	delivery_target: string;
	status: string;
	last_run_at: string | null;
	last_run_status: string | null;
	last_run_duration_ms: number | null;
	last_run_error: string | null;
	last_delivery_status: string | null;
	next_run_at: string | null;
	run_count: number;
	consecutive_errors: number;
	delete_after_run: number;
	created_at: string;
	created_by: string;
	updated_at: string;
};

// Accepted Slack delivery targets. "owner" is a symbolic value that resolves
// at delivery time to the configured Slack owner user id. Channel ids begin
// with "C", user ids with "U". Anything else is rejected at creation time.
const SLACK_TARGET_RE = /^(?:owner|C[A-Z0-9]+|U[A-Z0-9]+)$/;
export function isValidSlackTarget(target: string): boolean {
	return SLACK_TARGET_RE.test(target);
}
