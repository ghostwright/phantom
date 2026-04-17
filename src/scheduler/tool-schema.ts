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
