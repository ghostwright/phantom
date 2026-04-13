import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Scheduler } from "./service.ts";
import { AtScheduleSchema, CronScheduleSchema, EveryScheduleSchema, JobDeliverySchema } from "./types.ts";

const ScheduleInputSchema = z.discriminatedUnion("kind", [AtScheduleSchema, EveryScheduleSchema, CronScheduleSchema]);

function ok(data: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): { content: Array<{ type: "text"; text: string }>; isError: true } {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

const TOOL_DESCRIPTION = `Create, list, delete, or trigger scheduled tasks. Lets you set up recurring jobs, one-shot reminders, and automated reports.

Actions:
- create: Create a new scheduled task. Returns the job id and next run time. Rejects invalid schedules, past timestamps, duplicate names, task text over 32 KB, and delivery targets that are not "owner", a channel id (C...), or a user id (U...).
- list: List all scheduled tasks with status and next run time. Corrupt rows are logged and skipped.
- delete: Remove a scheduled task by jobId or by name (case insensitive).
- run: Trigger a task immediately. Only runs when status is active and no other job is currently executing. Returns the task output.

Schedule types:
- { kind: "at", at: "2026-03-26T09:00:00-07:00" } -> one-shot at a specific instant. Always pass an ISO 8601 timestamp with an explicit offset or a "Z" suffix; bare local times (e.g. "2026-03-26 09:00") resolve against the VM's local timezone.
- { kind: "every", intervalMs: 1800000 } -> recurring interval, counted from the end of the previous run.
- { kind: "cron", expr: "0 9 * * 1-5", tz: "America/Los_Angeles" } -> standard 5-field cron.

Cron syntax (5 fields only, no seconds, no nicknames, no Quartz extensions):
    minute  hour  day-of-month  month  day-of-week
    0-59    0-23  1-31          1-12   0-6 (0 or 7 = Sunday)
- Step: "*/10" fires every 10 units
- Range: "1-5" covers Monday through Friday when used in the day-of-week field
- Range with step: "0-30/5" fires at 0, 5, 10, ..., 30
- Month and day-of-week name aliases: JAN..DEC, SUN..SAT
- Day-of-month and day-of-week combine with OR semantics: "0 9 1 * MON" fires on the 1st of the month AND every Monday
- Timezone: pass tz as an IANA name (e.g. America/Los_Angeles, Europe/Berlin, UTC).
- DST: during spring-forward the nonexistent local hour is remapped to the next valid moment. A cron fire at "30 2 8 3 *" in America/Los_Angeles will fire at 3:30 local on spring-forward day because 2:30 does not exist that day.

Cron examples:
- "*/15 * * * *"              -> every 15 minutes
- "0 9 * * 1-5"               -> 9:00am Monday through Friday
- "30 8,12,17 * * *"          -> 8:30, 12:30, 17:30 every day
- "0 0 1 * *"                 -> midnight on the 1st of every month
- "0 9 * * 1"                 -> 9am every Monday
- "0-30/5 * * * 1-5"          -> every 5 minutes during the first half hour of every weekday

Delivery:
- { channel: "slack", target: "owner" } -> DM the configured owner (default). If slack.owner_user_id is unset in channels.yaml, delivery records "dropped:owner_user_id_unset" and logs a loud error.
- { channel: "slack", target: "U04ABC123" } -> DM a specific Slack user.
- { channel: "slack", target: "C04ABC123" } -> post to a Slack channel.
- { channel: "none" } -> silent (no delivery, useful for maintenance tasks).
Anything else (e.g. "#general", "alice") is rejected at creation time.

When creating a task, write the task prompt as a complete, self-contained instruction. Include every piece of context the scheduled run will need; it will NOT have access to the current conversation history. If a scheduled fire hits while a prior run of the same job is still executing, the scheduler skips the fire and retries at the next wake-up.`;

export function createSchedulerToolServer(scheduler: Scheduler): McpSdkServerConfigWithInstance {
	const scheduleTool = tool(
		"phantom_schedule",
		TOOL_DESCRIPTION,
		{
			action: z
				.enum(["create", "list", "delete", "run"])
				.describe(
					"create: new scheduled task. list: enumerate tasks. delete: remove by jobId or name. run: trigger immediately (only when status=active and scheduler is idle).",
				),
			name: z.string().optional().describe("Job name (required for create)"),
			description: z.string().optional().describe("Job description"),
			schedule: ScheduleInputSchema.optional().describe("Schedule definition (required for create)"),
			task: z
				.string()
				.optional()
				.describe("The prompt for the agent when the job fires (required for create, 32 KB max)"),
			delivery: JobDeliverySchema.optional().describe("Where to deliver results"),
			jobId: z.string().optional().describe("Job ID (for delete or run)"),
		},
		async (input) => {
			try {
				switch (input.action) {
					case "create": {
						if (!input.name) return err("name is required for create");
						if (!input.schedule) return err("schedule is required for create");
						if (!input.task) return err("task is required for create");

						const job = scheduler.createJob({
							name: input.name,
							description: input.description,
							schedule: input.schedule,
							task: input.task,
							delivery: input.delivery,
							deleteAfterRun: input.schedule.kind === "at",
						});

						return ok({
							created: true,
							id: job.id,
							name: job.name,
							schedule: job.schedule,
							nextRunAt: job.nextRunAt,
							delivery: job.delivery,
						});
					}

					case "list": {
						const jobs = scheduler.listJobs();
						return ok({
							count: jobs.length,
							jobs: jobs.map((j) => ({
								id: j.id,
								name: j.name,
								description: j.description,
								enabled: j.enabled,
								schedule: j.schedule,
								status: j.status,
								nextRunAt: j.nextRunAt,
								lastRunAt: j.lastRunAt,
								lastRunStatus: j.lastRunStatus,
								lastDeliveryStatus: j.lastDeliveryStatus,
								runCount: j.runCount,
								consecutiveErrors: j.consecutiveErrors,
								delivery: j.delivery,
							})),
						});
					}

					case "delete": {
						const targetId = input.jobId ?? scheduler.findJobIdByName(input.name);
						if (!targetId) return err("Provide jobId or name to delete");

						const deleted = scheduler.deleteJob(targetId);
						return ok({ deleted, id: targetId });
					}

					case "run": {
						const targetId = input.jobId ?? scheduler.findJobIdByName(input.name);
						if (!targetId) return err("Provide jobId or name to run");

						const result = await scheduler.runJobNow(targetId);
						return ok({ triggered: true, id: targetId, result });
					}

					default:
						return err(`Unknown action: ${input.action}`);
				}
			} catch (error: unknown) {
				const msg = error instanceof Error ? error.message : String(error);
				return err(msg);
			}
		},
	);

	return createSdkMcpServer({
		name: "phantom-scheduler",
		tools: [scheduleTool],
	});
}
