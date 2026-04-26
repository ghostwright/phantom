// Single source of truth for the shape of a "create a scheduled job" input.
// Both the phantom_schedule MCP tool (src/scheduler/tool.ts) and the UI
// create endpoint (src/ui/api/scheduler.ts) parse through the same Zod
// schema so field-for-field parity is automatic. The Sonnet describe-assist
// endpoint validates Sonnet's structured output against the same schema
// before surfacing the proposal to the operator.

import { z } from "zod";
import { AtScheduleSchema, CronScheduleSchema, EveryScheduleSchema, JobDeliverySchema } from "./types.ts";

export const ScheduleInputSchema = z.discriminatedUnion("kind", [
	AtScheduleSchema,
	EveryScheduleSchema,
	CronScheduleSchema,
]);

export const JobCreateInputSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
	schedule: ScheduleInputSchema,
	task: z
		.string()
		.min(1)
		.max(32 * 1024),
	delivery: JobDeliverySchema.optional(),
	deleteAfterRun: z.boolean().optional(),
	enabled: z.boolean().optional(),
	createdBy: z.enum(["agent", "user"]).optional(),
});

export type JobCreateInputParsed = z.infer<typeof JobCreateInputSchema>;

// Partial-update shape for Scheduler.updateJob. All fields optional with a
// refine() that rejects an empty object so the caller cannot silently no-op.
// Excludes identity columns (name, createdBy) and history columns
// (last_run_*, run_count, consecutive_errors, created_at): name is the
// human-readable lookup handle and renaming mid-life breaks cross-references,
// history is owned by the executor and would erase the run trail an update
// is supposed to preserve.
export const JobUpdateInputSchema = z
	.object({
		description: z.string().max(1000).optional(),
		schedule: ScheduleInputSchema.optional(),
		task: z
			.string()
			.min(1)
			.max(32 * 1024)
			.optional(),
		delivery: JobDeliverySchema.optional(),
		enabled: z.boolean().optional(),
	})
	.refine(
		(v) =>
			v.description !== undefined ||
			v.schedule !== undefined ||
			v.task !== undefined ||
			v.delivery !== undefined ||
			v.enabled !== undefined,
		{ message: "update requires at least one of: description, schedule, task, delivery, enabled" },
	);

export type JobUpdateInputParsed = z.infer<typeof JobUpdateInputSchema>;
