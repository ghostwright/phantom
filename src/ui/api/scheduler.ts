// UI API routes for the scheduler dashboard tab.
//
// All routes live under /ui/api/scheduler and are cookie-auth gated by the
// dispatcher in src/ui/serve.ts.
//
//   GET    /ui/api/scheduler
//   GET    /ui/api/scheduler/:id
//   GET    /ui/api/scheduler/:id/audit?limit=20
//   POST   /ui/api/scheduler
//   POST   /ui/api/scheduler/preview
//   POST   /ui/api/scheduler/parse          (Sonnet describe-assist)
//   POST   /ui/api/scheduler/:id/pause
//   POST   /ui/api/scheduler/:id/resume
//   POST   /ui/api/scheduler/:id/run
//   DELETE /ui/api/scheduler/:id
//
// Create/pause/resume/run/delete flow through scheduler.* methods so the UI
// path and the phantom_schedule MCP path share the same validation and side
// effects. The audit log records every mutation the UI issues.
//
// CARDINAL RULE: the /parse endpoint fills a form. The operator reviews and
// edits the proposal before calling POST /ui/api/scheduler. Sonnet never
// drives the agent at run time. Uses the Agent SDK subprocess so the
// operator's existing auth (Claude subscription or ANTHROPIC_API_KEY) carries
// through. See src/scheduler/parse-with-sonnet.ts for the full comment.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AgentRuntime } from "../../agent/runtime.ts";
import { humanReadableSchedule } from "../../scheduler/human.ts";
import { type ParseResult, parseJobDescription } from "../../scheduler/parse-with-sonnet.ts";
import { computeNextRunAt, validateSchedule } from "../../scheduler/schedule.ts";
import type { Scheduler } from "../../scheduler/service.ts";
import { JobCreateInputSchema, ScheduleInputSchema } from "../../scheduler/tool-schema.ts";
import type { JobCreateInput } from "../../scheduler/types.ts";

export type SchedulerApiDeps = {
	db: Database;
	scheduler: Scheduler;
	runtime?: AgentRuntime | null;
	// Test seam so the parse endpoint can be exercised without spawning a
	// subprocess. Production wiring leaves this undefined and the handler
	// falls back to parseJobDescription with the runtime.
	parser?: (description: string) => Promise<ParseResult>;
};

const AUDIT_LIMIT_DEFAULT = 20;
const AUDIT_LIMIT_MAX = 100;
const DESCRIPTION_MAX = 2000;

const DescribeSchema = z.object({
	description: z.string().min(1).max(DESCRIPTION_MAX),
});

const PreviewSchema = z.object({
	schedule: ScheduleInputSchema,
});

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

function errJson(error: string, status: number): Response {
	return json({ error }, { status });
}

function zodErrorMessage(err: z.ZodError): string {
	const issue = err.issues[0];
	const path = issue?.path?.length ? issue.path.join(".") : "body";
	return `${path}: ${issue?.message ?? "invalid input"}`;
}

async function parseJsonBody<T>(
	req: Request,
	schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string; status: number }> {
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return { ok: false, error: "Invalid JSON body", status: 400 };
	}
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		return { ok: false, error: zodErrorMessage(parsed.error), status: 400 };
	}
	return { ok: true, value: parsed.data };
}

function writeAudit(
	db: Database,
	row: {
		jobId: string;
		jobName: string | null;
		action: string;
		previousStatus?: string | null;
		newStatus?: string | null;
		detail?: string | null;
		actor?: string;
	},
): void {
	db.run(
		`INSERT INTO scheduler_audit_log (job_id, job_name, action, previous_status, new_status, actor, detail)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		[
			row.jobId,
			row.jobName,
			row.action,
			row.previousStatus ?? null,
			row.newStatus ?? null,
			row.actor ?? "user",
			row.detail ?? null,
		],
	);
}

// -- GET handlers ---------------------------------------------------------

function handleList(deps: SchedulerApiDeps): Response {
	const summary = deps.scheduler.getHealthSummary();
	const jobs = deps.scheduler.listJobs();
	return json({ summary, jobs });
}

function handleDetail(deps: SchedulerApiDeps, id: string): Response {
	const job = deps.scheduler.getJob(id);
	if (!job) return errJson("Job not found", 404);
	return json({ job });
}

function handleAudit(deps: SchedulerApiDeps, id: string, url: URL): Response {
	const limitParam = url.searchParams.get("limit");
	let limit = AUDIT_LIMIT_DEFAULT;
	if (limitParam !== null) {
		const n = Number(limitParam);
		if (!Number.isFinite(n) || n <= 0) return errJson("limit must be a positive integer", 400);
		limit = Math.min(Math.floor(n), AUDIT_LIMIT_MAX);
	}
	const rows = deps.db
		.query(
			"SELECT id, job_id, job_name, action, previous_status, new_status, actor, detail, created_at FROM scheduler_audit_log WHERE job_id = ? ORDER BY id DESC LIMIT ?",
		)
		.all(id, limit) as Array<{
		id: number;
		job_id: string;
		job_name: string | null;
		action: string;
		previous_status: string | null;
		new_status: string | null;
		actor: string;
		detail: string | null;
		created_at: string;
	}>;
	return json({ entries: rows });
}

// -- POST handlers --------------------------------------------------------

async function handleCreate(req: Request, deps: SchedulerApiDeps): Promise<Response> {
	// Parse JSON once so we can tell "oversized task" (413) apart from other
	// validation failures (400) before Zod rejects the over-limit string.
	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return errJson("Invalid JSON body", 400);
	}
	if (raw && typeof raw === "object" && "task" in raw) {
		const task = (raw as { task?: unknown }).task;
		if (typeof task === "string" && Buffer.byteLength(task, "utf8") > 32 * 1024) {
			return errJson("task text exceeds 32 KB limit", 413);
		}
	}

	const parsed = JobCreateInputSchema.safeParse(raw);
	if (!parsed.success) return errJson(zodErrorMessage(parsed.error), 400);

	const input = parsed.data;

	// Zod's output type leaves fields with .default() as optional on the
	// inferred type, even though the parser always fills them. Normalize the
	// delivery shape here so scheduler.createJob receives the full JobDelivery.
	const serviceInput: JobCreateInput = {
		name: input.name,
		description: input.description,
		schedule: input.schedule,
		task: input.task,
		deleteAfterRun: input.deleteAfterRun,
		enabled: input.enabled,
		createdBy: input.createdBy ?? "user",
		...(input.delivery
			? {
					delivery: {
						channel: input.delivery.channel ?? "slack",
						target: input.delivery.target ?? "owner",
					},
				}
			: {}),
	};

	try {
		const job = deps.scheduler.createJob(serviceInput);
		writeAudit(deps.db, {
			jobId: job.id,
			jobName: job.name,
			action: "create",
			newStatus: job.status,
			actor: input.createdBy ?? "user",
		});
		return json({ job }, { status: 201 });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/already exists/i.test(msg)) return errJson(msg, 409);
		if (/job limit reached/i.test(msg)) return errJson(msg, 429);
		if (/exceeds\s+\d+\s+byte limit/i.test(msg)) return errJson(msg, 413);
		return errJson(msg, 400);
	}
}

async function handlePreview(req: Request): Promise<Response> {
	const body = await parseJsonBody(req, PreviewSchema);
	if (!body.ok) return errJson(body.error, body.status);

	const scheduleError = validateSchedule(body.value.schedule);
	if (scheduleError) {
		return json({ nextRunAt: null, humanReadable: null, error: scheduleError });
	}
	const next = computeNextRunAt(body.value.schedule);
	return json({
		nextRunAt: next ? next.toISOString() : null,
		humanReadable: humanReadableSchedule(body.value.schedule),
		error: null,
	});
}

async function handleParse(req: Request, deps: SchedulerApiDeps): Promise<Response> {
	const body = await parseJsonBody(req, DescribeSchema);
	if (!body.ok) return errJson(body.error, body.status);

	const result = deps.parser
		? await deps.parser(body.value.description)
		: await parseJobDescription(body.value.description, { runtime: deps.runtime ?? null });
	if (result.ok) {
		return json({ proposal: result.proposal, warnings: result.warnings });
	}
	return errJson(result.error, result.status);
}

function handlePause(deps: SchedulerApiDeps, id: string): Response {
	const before = deps.scheduler.getJob(id);
	if (!before) return errJson("Job not found", 404);
	const updated = deps.scheduler.pauseJob(id);
	if (!updated) return errJson("Job not found", 404);
	writeAudit(deps.db, {
		jobId: updated.id,
		jobName: updated.name,
		action: "pause",
		previousStatus: before.status,
		newStatus: updated.status,
	});
	return json({ job: updated });
}

function handleResume(deps: SchedulerApiDeps, id: string): Response {
	const before = deps.scheduler.getJob(id);
	if (!before) return errJson("Job not found", 404);
	const updated = deps.scheduler.resumeJob(id);
	if (!updated) return errJson("Job not found", 404);
	writeAudit(deps.db, {
		jobId: updated.id,
		jobName: updated.name,
		action: "resume",
		previousStatus: before.status,
		newStatus: updated.status,
	});
	return json({ job: updated });
}

async function handleRun(deps: SchedulerApiDeps, id: string): Promise<Response> {
	const before = deps.scheduler.getJob(id);
	if (!before) return errJson("Job not found", 404);
	try {
		const result = await deps.scheduler.runJobNow(id);
		const after = deps.scheduler.getJob(id);
		writeAudit(deps.db, {
			jobId: id,
			jobName: before.name,
			action: "run",
			previousStatus: before.status,
			newStatus: after?.status ?? before.status,
			detail: result.length > 256 ? `${result.slice(0, 256)}...` : result,
		});
		return json({ result, job: after });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/currently executing/i.test(msg)) return errJson(msg, 409);
		if (/status\s+'[^']+'/.test(msg)) return errJson(msg, 409);
		if (/disabled/i.test(msg)) return errJson(msg, 409);
		if (/not found/i.test(msg)) return errJson(msg, 404);
		return errJson(msg, 500);
	}
}

function handleDelete(deps: SchedulerApiDeps, id: string): Response {
	const before = deps.scheduler.getJob(id);
	if (!before) return errJson("Job not found", 404);
	const deleted = deps.scheduler.deleteJob(id);
	if (!deleted) return errJson("Job not found", 404);
	writeAudit(deps.db, {
		jobId: id,
		jobName: before.name,
		action: "delete",
		previousStatus: before.status,
		newStatus: null,
	});
	return json({ deleted: true });
}

// -- Dispatcher -----------------------------------------------------------

export async function handleSchedulerApi(req: Request, url: URL, deps: SchedulerApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	if (pathname === "/ui/api/scheduler") {
		if (req.method === "GET") return handleList(deps);
		if (req.method === "POST") return handleCreate(req, deps);
		return errJson("Method not allowed", 405);
	}

	if (pathname === "/ui/api/scheduler/preview" && req.method === "POST") {
		return handlePreview(req);
	}

	if (pathname === "/ui/api/scheduler/parse" && req.method === "POST") {
		return handleParse(req, deps);
	}

	const auditMatch = pathname.match(/^\/ui\/api\/scheduler\/([^/]+)\/audit$/);
	if (auditMatch) {
		if (req.method !== "GET") return errJson("Method not allowed", 405);
		return handleAudit(deps, auditMatch[1], url);
	}

	const pauseMatch = pathname.match(/^\/ui\/api\/scheduler\/([^/]+)\/pause$/);
	if (pauseMatch) {
		if (req.method !== "POST") return errJson("Method not allowed", 405);
		return handlePause(deps, pauseMatch[1]);
	}

	const resumeMatch = pathname.match(/^\/ui\/api\/scheduler\/([^/]+)\/resume$/);
	if (resumeMatch) {
		if (req.method !== "POST") return errJson("Method not allowed", 405);
		return handleResume(deps, resumeMatch[1]);
	}

	const runMatch = pathname.match(/^\/ui\/api\/scheduler\/([^/]+)\/run$/);
	if (runMatch) {
		if (req.method !== "POST") return errJson("Method not allowed", 405);
		return handleRun(deps, runMatch[1]);
	}

	const detailMatch = pathname.match(/^\/ui\/api\/scheduler\/([^/]+)$/);
	if (detailMatch) {
		const id = detailMatch[1];
		if (req.method === "GET") return handleDetail(deps, id);
		if (req.method === "DELETE") return handleDelete(deps, id);
		return errJson("Method not allowed", 405);
	}

	return null;
}
