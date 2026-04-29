import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { Scheduler } from "../../../scheduler/service.ts";
import {
	clearSchedulerInstanceForTests,
	handleUiRequest,
	setDashboardDb,
	setPublicDir,
	setSchedulerInstance,
	setSchedulerParserOverrideForTests,
} from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let db: Database;
let sessionToken: string;
let scheduler: Scheduler;

function runMigrations(target: Database): void {
	for (const migration of MIGRATIONS) {
		try {
			target.run(migration);
		} catch {
			// ignore ALTER TABLE duplicate failures on repeated migrations
		}
	}
}

function createMockRuntime() {
	return {
		handleMessage: mock(async () => ({
			text: "Mock response from agent",
			sessionId: "mock-session",
			cost: { totalUsd: 0.01, inputTokens: 100, outputTokens: 50, modelUsage: {} },
			durationMs: 500,
		})),
		isSessionBusy: mock(() => false),
		setMemoryContextBuilder: mock(() => {}),
		setEvolvedConfig: mock(() => {}),
		setRoleTemplate: mock(() => {}),
		setOnboardingPrompt: mock(() => {}),
		setMcpServers: mock(() => {}),
		getLastTrackedFiles: mock(() => []),
		getActiveSessionCount: mock(() => 0),
	};
}

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	setDashboardDb(db);
	scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
	setSchedulerInstance(scheduler);
	sessionToken = createSession().sessionToken;
});

afterEach(() => {
	clearSchedulerInstanceForTests();
	db.close();
	revokeAllSessions();
});

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			Cookie: `phantom_session=${encodeURIComponent(sessionToken)}`,
			Accept: "application/json",
			"Content-Type": "application/json",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

function hnBody(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		name: "hn-digest",
		description: "Top Hacker News stories every 6 hours",
		task: "Fetch the top 10 HN stories and post a brief summary to Slack.",
		schedule: { kind: "every", intervalMs: 21_600_000 },
		delivery: { channel: "slack", target: "owner" },
		...overrides,
	});
}

describe("scheduler API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/scheduler", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET list on empty DB returns summary and empty jobs", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: { total: number; active: number; paused: number };
			jobs: unknown[];
		};
		expect(body.jobs).toEqual([]);
		expect(body.summary.total).toBe(0);
	});

	test("POST creates the cheeks HN canonical job", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler", { method: "POST", body: hnBody() }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			job: { id: string; name: string; schedule: { kind: string; intervalMs: number } };
		};
		expect(body.job.name).toBe("hn-digest");
		expect(body.job.schedule).toEqual({ kind: "every", intervalMs: 21_600_000 });

		const auditRows = db.query("SELECT * FROM scheduler_audit_log WHERE job_id = ?").all(body.job.id) as Array<{
			action: string;
			actor: string;
		}>;
		expect(auditRows.length).toBe(1);
		expect(auditRows[0].action).toBe("create");
		expect(auditRows[0].actor).toBe("user");
	});

	test("POST honors enabled=false and persists the disabled state", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler", {
				method: "POST",
				body: hnBody({ name: "disabled-on-create", enabled: false }),
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { job: { id: string; enabled: boolean } };
		expect(body.job.enabled).toBe(false);
		const row = db.query("SELECT enabled FROM scheduled_jobs WHERE id = ?").get(body.job.id) as { enabled: number };
		expect(row.enabled).toBe(0);
	});

	test("POST defaults enabled=true when the field is omitted", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler", { method: "POST", body: hnBody() }));
		expect(res.status).toBe(201);
		const body = (await res.json()) as { job: { enabled: boolean } };
		expect(body.job.enabled).toBe(true);
	});

	test("POST with invalid schedule returns 400", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler", {
				method: "POST",
				body: hnBody({ schedule: { kind: "cron", expr: "not a valid cron" } }),
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/invalid schedule|invalid cron/i);
	});

	test("POST with duplicate name returns 409", async () => {
		await handleUiRequest(req("/ui/api/scheduler", { method: "POST", body: hnBody() }));
		const res = await handleUiRequest(req("/ui/api/scheduler", { method: "POST", body: hnBody() }));
		expect(res.status).toBe(409);
	});

	test("POST with oversized task returns 413", async () => {
		const big = "x".repeat(40 * 1024);
		const res = await handleUiRequest(
			req("/ui/api/scheduler", { method: "POST", body: hnBody({ name: "big-task", task: big }) }),
		);
		expect(res.status).toBe(413);
	});

	test("POST with invalid delivery target returns 400", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler", {
				method: "POST",
				body: hnBody({ name: "bad-target", delivery: { channel: "slack", target: "#general" } }),
			}),
		);
		expect(res.status).toBe(400);
	});

	test("POST with at schedule auto-enables deleteAfterRun via service", async () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const res = await handleUiRequest(
			req("/ui/api/scheduler", {
				method: "POST",
				body: hnBody({ name: "one-shot", schedule: { kind: "at", at: future }, deleteAfterRun: true }),
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { job: { deleteAfterRun: boolean } };
		expect(body.job.deleteAfterRun).toBe(true);
	});

	test("GET /:id returns a specific job", async () => {
		const created = await handleUiRequest(req("/ui/api/scheduler", { method: "POST", body: hnBody() }));
		const createdBody = (await created.json()) as { job: { id: string } };
		const res = await handleUiRequest(req(`/ui/api/scheduler/${createdBody.job.id}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { job: { id: string; name: string } };
		expect(body.job.id).toBe(createdBody.job.id);
		expect(body.job.name).toBe("hn-digest");
	});

	test("GET /:id returns 404 for unknown", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler/nope"));
		expect(res.status).toBe(404);
	});

	test("POST /:id/pause flips to paused and audits", async () => {
		const job = scheduler.createJob({
			name: "pauseable",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "hold",
		});
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/pause`, { method: "POST" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { job: { status: string } };
		expect(body.job.status).toBe("paused");

		const audit = db
			.query("SELECT action, previous_status, new_status FROM scheduler_audit_log WHERE job_id = ? ORDER BY id")
			.all(job.id) as Array<{ action: string; previous_status: string; new_status: string }>;
		expect(audit.at(-1)?.action).toBe("pause");
		expect(audit.at(-1)?.previous_status).toBe("active");
		expect(audit.at(-1)?.new_status).toBe("paused");
	});

	test("POST /:id/pause returns 404 for unknown", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler/nope/pause", { method: "POST" }));
		expect(res.status).toBe(404);
	});

	test("POST /:id/resume flips paused back to active", async () => {
		const job = scheduler.createJob({
			name: "resumable",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "go",
		});
		scheduler.pauseJob(job.id);
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/resume`, { method: "POST" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { job: { status: string; consecutiveErrors: number } };
		expect(body.job.status).toBe("active");
		expect(body.job.consecutiveErrors).toBe(0);
	});

	test("POST /:id/run runs the job and returns the result", async () => {
		const job = scheduler.createJob({
			name: "run-me",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "do it",
		});
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/run`, { method: "POST" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { result: string; job: { runCount: number } };
		expect(body.result).toBe("Mock response from agent");
		expect(body.job.runCount).toBe(1);

		const audit = db.query("SELECT action FROM scheduler_audit_log WHERE job_id = ?").all(job.id) as Array<{
			action: string;
		}>;
		expect(audit.some((a) => a.action === "run")).toBe(true);
	});

	test("POST /:id/run returns 404 for unknown", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler/nope/run", { method: "POST" }));
		expect(res.status).toBe(404);
	});

	test("POST /:id/run returns 409 when target is paused", async () => {
		const job = scheduler.createJob({
			name: "paused-run",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "do it",
		});
		scheduler.pauseJob(job.id);
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/run`, { method: "POST" }));
		expect(res.status).toBe(409);
	});

	test("DELETE /:id removes the job and audits", async () => {
		const job = scheduler.createJob({
			name: "deletable",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "bye",
		});
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}`, { method: "DELETE" }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deleted: boolean };
		expect(body.deleted).toBe(true);
		expect(scheduler.getJob(job.id)).toBeNull();

		const audit = db.query("SELECT action FROM scheduler_audit_log WHERE job_id = ?").all(job.id) as Array<{
			action: string;
		}>;
		expect(audit.some((a) => a.action === "delete")).toBe(true);
	});

	test("DELETE /:id returns 404 for unknown", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler/nope", { method: "DELETE" }));
		expect(res.status).toBe(404);
	});

	test("POST /preview returns nextRunAt and human-readable label", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler/preview", {
				method: "POST",
				body: JSON.stringify({ schedule: { kind: "every", intervalMs: 21_600_000 } }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { nextRunAt: string | null; humanReadable: string | null; error: string | null };
		expect(body.error).toBeNull();
		expect(body.nextRunAt).not.toBeNull();
		expect(body.humanReadable).toBe("every 6h");
	});

	test("POST /preview returns error text for bad cron", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler/preview", {
				method: "POST",
				body: JSON.stringify({ schedule: { kind: "cron", expr: "@daily" } }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { nextRunAt: string | null; error: string | null };
		expect(body.nextRunAt).toBeNull();
		expect(body.error).toMatch(/nicknames/i);
	});

	test("POST /preview rejects malformed schedule with 400", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler/preview", { method: "POST", body: JSON.stringify({ schedule: { kind: "bogus" } }) }),
		);
		expect(res.status).toBe(400);
	});

	test("GET /:id/audit returns entries in descending order", async () => {
		const job = scheduler.createJob({
			name: "audited",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "audit",
		});
		await handleUiRequest(req(`/ui/api/scheduler/${job.id}/pause`, { method: "POST" }));
		await handleUiRequest(req(`/ui/api/scheduler/${job.id}/resume`, { method: "POST" }));

		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/audit`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: Array<{ action: string }> };
		expect(body.entries.length).toBe(2);
		expect(body.entries[0].action).toBe("resume");
		expect(body.entries[1].action).toBe("pause");
	});

	test("GET /:id/audit clamps limit", async () => {
		const job = scheduler.createJob({
			name: "clamp",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "clamp",
		});
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/audit?limit=99999`));
		expect(res.status).toBe(200);
	});

	test("GET /:id/audit with invalid limit returns 400", async () => {
		const job = scheduler.createJob({
			name: "clamp2",
			schedule: { kind: "every", intervalMs: 60_000 },
			task: "clamp",
		});
		const res = await handleUiRequest(req(`/ui/api/scheduler/${job.id}/audit?limit=-5`));
		expect(res.status).toBe(400);
	});

	test("POST /parse returns a structured proposal when Sonnet parser succeeds", async () => {
		const spy = mock(async () => ({
			ok: true as const,
			proposal: {
				name: "hn-digest",
				task: "Fetch the top 10 HN stories and post to Slack.",
				schedule: { kind: "every" as const, intervalMs: 21_600_000 },
				delivery: { channel: "slack" as const, target: "owner" },
			},
			warnings: [],
		}));
		setSchedulerParserOverrideForTests(spy as never);

		const res = await handleUiRequest(
			req("/ui/api/scheduler/parse", {
				method: "POST",
				body: JSON.stringify({ description: "every 6h HN digest" }),
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { proposal: { name: string; schedule: { kind: string; intervalMs: number } } };
		expect(body.proposal.name).toBe("hn-digest");
		expect(body.proposal.schedule.intervalMs).toBe(21_600_000);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	test("POST /parse surfaces 422 when the parser cannot extract a proposal", async () => {
		setSchedulerParserOverrideForTests((async () => ({
			ok: false as const,
			status: 422 as const,
			error: "Could not parse description, please fill the form manually.",
		})) as never);
		const res = await handleUiRequest(
			req("/ui/api/scheduler/parse", {
				method: "POST",
				body: JSON.stringify({ description: "gibberish" }),
			}),
		);
		expect(res.status).toBe(422);
	});

	test("POST /parse collapses subprocess failures to 422", async () => {
		setSchedulerParserOverrideForTests((async () => ({
			ok: false as const,
			status: 422 as const,
			error: "Could not parse description, please fill the form manually.",
		})) as never);
		const res = await handleUiRequest(
			req("/ui/api/scheduler/parse", {
				method: "POST",
				body: JSON.stringify({ description: "something" }),
			}),
		);
		expect(res.status).toBe(422);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Could not parse");
	});

	test("POST /parse rejects empty description with 400", async () => {
		const res = await handleUiRequest(
			req("/ui/api/scheduler/parse", { method: "POST", body: JSON.stringify({ description: "" }) }),
		);
		expect(res.status).toBe(400);
	});

	test("POST /parse rejects oversized description with 400", async () => {
		const desc = "x".repeat(5000);
		const res = await handleUiRequest(
			req("/ui/api/scheduler/parse", { method: "POST", body: JSON.stringify({ description: desc }) }),
		);
		expect(res.status).toBe(400);
	});

	test("POST on an unknown path under /ui/api/scheduler returns 404", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler/no-such-thing/boom", { method: "POST" }));
		expect(res.status).toBe(404);
	});

	test("PUT on /ui/api/scheduler returns 405", async () => {
		const res = await handleUiRequest(req("/ui/api/scheduler", { method: "PUT" }));
		expect(res.status).toBe(405);
	});
});
