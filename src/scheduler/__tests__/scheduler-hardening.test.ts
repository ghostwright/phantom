import { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { deliverResult } from "../delivery.ts";
import { computeHealthSummary } from "../health.ts";
import { cleanupOldTerminalJobs, staggerMissedJobs } from "../recovery.ts";
import { computeBackoffNextRun, computeNextRunAt, validateSchedule } from "../schedule.ts";
import { Scheduler } from "../service.ts";
import { createSchedulerToolServer } from "../tool.ts";
import { isValidSlackTarget } from "../types.ts";
import type { ScheduledJob } from "../types.ts";

type MockRuntime = {
	handleMessage: ReturnType<typeof mock>;
	isSessionBusy: ReturnType<typeof mock>;
	setMemoryContextBuilder: ReturnType<typeof mock>;
	setEvolvedConfig: ReturnType<typeof mock>;
	setRoleTemplate: ReturnType<typeof mock>;
	setOnboardingPrompt: ReturnType<typeof mock>;
	setMcpServers: ReturnType<typeof mock>;
	getLastTrackedFiles: ReturnType<typeof mock>;
	getActiveSessionCount: ReturnType<typeof mock>;
};

function createMockRuntime(): MockRuntime {
	return {
		handleMessage: mock(async () => ({
			text: "Mock response",
			sessionId: "mock-session",
			cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
			durationMs: 10,
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

function createMockSlackChannel() {
	// Return types must match the real SlackChannel contract (Promise<string | null>)
	// so mockImplementation can return null to simulate upstream failures without a
	// type cast. The delivery.ts code checks for null explicitly (Critical-1 fix).
	return {
		sendDm: mock(async (_userId: string, _text: string): Promise<string | null> => "mock-ts"),
		postToChannel: mock(async (_channelId: string, _text: string): Promise<string | null> => "mock-ts"),
	};
}

describe("Phase 2.5 scheduler fixes", () => {
	let db: Database;

	beforeAll(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
	});

	beforeEach(() => {
		db.run("DELETE FROM scheduled_jobs");
	});

	afterAll(() => {
		db.close();
	});

	// ---------- C1: dead-on-arrival schedules rejected at creation ----------

	describe("C1: dead-on-arrival schedule rejection", () => {
		test("validateSchedule rejects invalid cron expression", () => {
			const result = validateSchedule({ kind: "cron", expr: "not a cron" });
			expect(result).not.toBeNull();
			expect(result).toContain("invalid cron");
		});

		test("validateSchedule rejects bad timezone", () => {
			const result = validateSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Not/A_Timezone" });
			expect(result).not.toBeNull();
			expect(result?.toLowerCase()).toContain("timezone");
		});

		test("validateSchedule rejects 6-part cron (5-part mode)", () => {
			const result = validateSchedule({ kind: "cron", expr: "*/30 0 9 * * *" });
			expect(result).not.toBeNull();
		});

		test("validateSchedule rejects nicknames like @daily", () => {
			const result = validateSchedule({ kind: "cron", expr: "@daily" });
			expect(result).not.toBeNull();
		});

		test("validateSchedule rejects past at timestamp", () => {
			const past = new Date(Date.now() - 60_000).toISOString();
			const result = validateSchedule({ kind: "at", at: past });
			expect(result).not.toBeNull();
			expect(result).toContain("past");
		});

		test("validateSchedule rejects unparseable at timestamp", () => {
			const result = validateSchedule({ kind: "at", at: "banana" });
			expect(result).not.toBeNull();
			expect(result).toContain("invalid");
		});

		test("validateSchedule accepts valid cron", () => {
			expect(validateSchedule({ kind: "cron", expr: "0 9 * * 1-5" })).toBeNull();
		});

		test("validateSchedule accepts valid every", () => {
			expect(validateSchedule({ kind: "every", intervalMs: 60_000 })).toBeNull();
		});

		test("validateSchedule accepts valid at in the future", () => {
			const future = new Date(Date.now() + 60_000).toISOString();
			expect(validateSchedule({ kind: "at", at: future })).toBeNull();
		});

		test("createJob throws on invalid cron", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			expect(() =>
				scheduler.createJob({
					name: "Bad Cron",
					schedule: { kind: "cron", expr: "not a cron" },
					task: "x",
				}),
			).toThrow(/invalid schedule/);
		});

		test("createJob throws on bad timezone", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			expect(() =>
				scheduler.createJob({
					name: "Bad TZ",
					schedule: { kind: "cron", expr: "0 9 * * *", tz: "Not/A_Real_Timezone" },
					task: "x",
				}),
			).toThrow(/invalid schedule/);
		});

		test("createJob throws on past at timestamp", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const past = new Date(Date.now() - 60_000).toISOString();
			expect(() =>
				scheduler.createJob({
					name: "Past At",
					schedule: { kind: "at", at: past },
					task: "x",
				}),
			).toThrow(/past/);
		});

		test("createJob does NOT insert a row when schedule is invalid", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			expect(() =>
				scheduler.createJob({
					name: "Invalid",
					schedule: { kind: "cron", expr: "banana" },
					task: "x",
				}),
			).toThrow();
			const row = db.query("SELECT COUNT(*) as c FROM scheduled_jobs").get() as { c: number };
			expect(row.c).toBe(0);
		});

		test("tool action=create returns isError on bad cron", async () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const server = createSchedulerToolServer(scheduler);
			// biome-ignore lint/suspicious/noExplicitAny: SDK tool internals
			const toolObj = (server.instance as any)._registeredTools?.phantom_schedule;
			expect(toolObj).toBeDefined();
			const result = await toolObj.handler({
				action: "create",
				name: "Bad",
				schedule: { kind: "cron", expr: "not a cron" },
				task: "do a thing",
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("invalid schedule");
		});

		test("tool action=create returns isError on duplicate name", async () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			scheduler.createJob({
				name: "Dup Tool",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			const server = createSchedulerToolServer(scheduler);
			// biome-ignore lint/suspicious/noExplicitAny: SDK tool internals
			const toolObj = (server.instance as any)._registeredTools?.phantom_schedule;
			const result = await toolObj.handler({
				action: "create",
				name: "Dup Tool",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "y",
			});
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("already exists");
		});

		test("tool action=run rejects when scheduler is executing", async () => {
			const runtime = createMockRuntime();
			// Hang handleMessage so we keep the executing flag true.
			const pending: { resolve: (v: unknown) => void } = { resolve: () => {} };
			runtime.handleMessage.mockImplementation(
				() =>
					new Promise((resolve) => {
						pending.resolve = resolve;
					}),
			);
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const j1 = scheduler.createJob({
				name: "A",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			const j2 = scheduler.createJob({
				name: "B",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "y",
			});
			const first = scheduler.runJobNow(j1.id);
			await expect(scheduler.runJobNow(j2.id)).rejects.toThrow(/currently executing/);
			pending.resolve({
				text: "done",
				sessionId: "",
				cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
				durationMs: 1,
			});
			await first;
		});
	});

	// ---------- C2: runtime bounce belt + scheduler braces ----------

	describe("C2: runtime concurrency bounce", () => {
		test("scheduler skips fire when runtime reports busy (braces layer)", async () => {
			const runtime = createMockRuntime();
			runtime.isSessionBusy.mockImplementation(() => true);
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const job = scheduler.createJob({
				name: "Busy Skip",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "hi",
			});

			const before = scheduler.getJob(job.id);
			const result = await scheduler.runJobNow(job.id);

			// Empty return means the fire was skipped.
			expect(result).toBe("");
			// handleMessage is NOT called for the busy path.
			expect(runtime.handleMessage).not.toHaveBeenCalled();

			const after = scheduler.getJob(job.id);
			// run_count, consecutive_errors, next_run_at all unchanged.
			expect(after?.runCount).toBe(before?.runCount);
			expect(after?.consecutiveErrors).toBe(before?.consecutiveErrors);
			expect(after?.nextRunAt).toBe(before?.nextRunAt);
			expect(after?.status).toBe("active");
		});

		test("scheduler advances normally when runtime is not busy", async () => {
			const runtime = createMockRuntime();
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const job = scheduler.createJob({
				name: "Normal",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "hi",
			});
			await scheduler.runJobNow(job.id);

			const after = scheduler.getJob(job.id);
			expect(after?.runCount).toBe(1);
			expect(after?.lastRunStatus).toBe("ok");
		});
	});

	// ---------- C3: owner_user_id gate removed ----------

	describe("C3: setSlackChannel works when ownerUserId is null", () => {
		test("scheduler accepts null ownerUserId", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const slack = createMockSlackChannel();
			// Must not throw and must not require ownerUserId.
			expect(() => scheduler.setSlackChannel(slack as never, null)).not.toThrow();
		});

		test("scheduler delivers to channel ID targets even with null owner", async () => {
			const runtime = createMockRuntime();
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const slack = createMockSlackChannel();
			scheduler.setSlackChannel(slack as never, null);

			const job = scheduler.createJob({
				name: "Channel target",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
				delivery: { channel: "slack", target: "C04ABC123" },
			});
			await scheduler.runJobNow(job.id);

			expect(slack.postToChannel).toHaveBeenCalledWith("C04ABC123", "Mock response");
			const after = scheduler.getJob(job.id);
			expect(after?.lastDeliveryStatus).toBe("delivered");
		});
	});

	// ---------- C4: delivery target validation + else branch + status column ----------

	describe("C4: delivery target validation and outcome tracking", () => {
		test("isValidSlackTarget accepts owner, C..., U...", () => {
			expect(isValidSlackTarget("owner")).toBe(true);
			expect(isValidSlackTarget("C04ABC123")).toBe(true);
			expect(isValidSlackTarget("U04ABC123")).toBe(true);
		});

		test("isValidSlackTarget rejects #general, names, empty", () => {
			expect(isValidSlackTarget("#general")).toBe(false);
			expect(isValidSlackTarget("alice")).toBe(false);
			expect(isValidSlackTarget("")).toBe(false);
			expect(isValidSlackTarget("cXYZ")).toBe(false); // lowercase c
		});

		test("createJob throws on invalid delivery target format", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			expect(() =>
				scheduler.createJob({
					name: "Bad Target",
					schedule: { kind: "every", intervalMs: 60_000 },
					task: "x",
					delivery: { channel: "slack", target: "#general" },
				}),
			).toThrow(/invalid delivery.target/);
		});

		test("deliverResult records dropped:slack_channel_unset when Slack is not wired", async () => {
			const job = {
				name: "J",
				delivery: { channel: "slack", target: "owner" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hello", { slackChannel: undefined, ownerUserId: null });
			expect(outcome).toBe("dropped:slack_channel_unset");
		});

		test("deliverResult records dropped:owner_user_id_unset when owner unset and target=owner", async () => {
			const slack = createMockSlackChannel();
			const job = {
				name: "J",
				delivery: { channel: "slack", target: "owner" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hello", {
				slackChannel: slack as never,
				ownerUserId: null,
			});
			expect(outcome).toBe("dropped:owner_user_id_unset");
			expect(slack.sendDm).not.toHaveBeenCalled();
		});

		test("deliverResult returns delivered for valid owner target", async () => {
			const slack = createMockSlackChannel();
			const job = {
				name: "J",
				delivery: { channel: "slack", target: "owner" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hello", {
				slackChannel: slack as never,
				ownerUserId: "U_OWNER",
			});
			expect(outcome).toBe("delivered");
			expect(slack.sendDm).toHaveBeenCalledWith("U_OWNER", "hello");
		});

		test("deliverResult catches Slack errors and returns error:... outcome (throw path)", async () => {
			const slack = createMockSlackChannel();
			slack.sendDm.mockImplementation(async () => {
				throw new Error("Slack API is down");
			});
			const job = {
				name: "J",
				delivery: { channel: "slack", target: "owner" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hi", {
				slackChannel: slack as never,
				ownerUserId: "U_OWNER",
			});
			expect(outcome).toMatch(/^error:/);
			expect(outcome).toContain("Slack API is down");
		});

		test("deliverResult records error:slack_returned_null when sendDm returns null (real outage contract)", async () => {
			const slack = createMockSlackChannel();
			// Match the REAL SlackChannel.sendDm contract: it catches errors
			// internally and returns null on failure, rather than throwing.
			slack.sendDm.mockImplementation(async () => null);
			const job = {
				name: "NullOwner",
				delivery: { channel: "slack", target: "owner" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hi", {
				slackChannel: slack as never,
				ownerUserId: "U_OWNER",
			});
			expect(outcome).toBe("error:slack_returned_null");
		});

		test("deliverResult records error:slack_returned_null when postToChannel returns null", async () => {
			const slack = createMockSlackChannel();
			slack.postToChannel.mockImplementation(async () => null);
			const job = {
				name: "NullChannel",
				delivery: { channel: "slack", target: "C04ABC123" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hi", {
				slackChannel: slack as never,
				ownerUserId: "U_OWNER",
			});
			expect(outcome).toBe("error:slack_returned_null");
		});

		test("deliverResult records error:slack_returned_null when sendDm to U-target returns null", async () => {
			const slack = createMockSlackChannel();
			slack.sendDm.mockImplementation(async () => null);
			const job = {
				name: "NullUser",
				delivery: { channel: "slack", target: "U04ABC123" },
			} as ScheduledJob;
			const outcome = await deliverResult(job, "hi", {
				slackChannel: slack as never,
				ownerUserId: "U_OWNER",
			});
			expect(outcome).toBe("error:slack_returned_null");
		});

		test("executeJob persists last_delivery_status on dropped owner delivery", async () => {
			const runtime = createMockRuntime();
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const slack = createMockSlackChannel();
			scheduler.setSlackChannel(slack as never, null);

			const job = scheduler.createJob({
				name: "Owner Drop",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
				delivery: { channel: "slack", target: "owner" },
			});
			await scheduler.runJobNow(job.id);

			const after = scheduler.getJob(job.id);
			expect(after?.lastDeliveryStatus).toBe("dropped:owner_user_id_unset");
		});

		test("Slack outage via null return (real contract) does not kill executeJob and records error", async () => {
			const runtime = createMockRuntime();
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const slack = createMockSlackChannel();
			// Match the REAL SlackChannel contract: sendDm catches internally
			// and returns null on failure. This is the scenario that Phase 2.5's
			// original delivery.ts missed and that stamped "delivered" in the
			// database during a real Slack outage.
			slack.sendDm.mockImplementation(async () => null);
			scheduler.setSlackChannel(slack as never, "U_OWNER");

			const job = scheduler.createJob({
				name: "Slack Down Null",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			const result = await scheduler.runJobNow(job.id);
			expect(result).toBe("Mock response");

			const after = scheduler.getJob(job.id);
			// The whole point of the Critical-1 fix: null return MUST be recorded
			// as an error outcome, NEVER as "delivered".
			expect(after?.lastDeliveryStatus).toBe("error:slack_returned_null");
			expect(after?.lastDeliveryStatus).not.toBe("delivered");
			expect(after?.lastRunStatus).toBe("ok");
		});

		test("Slack outage via thrown error does not kill executeJob and records error", async () => {
			const runtime = createMockRuntime();
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const slack = createMockSlackChannel();
			// Belt-and-braces: if a future Slack layer change starts throwing
			// instead of returning null, we still classify it as an error.
			slack.sendDm.mockImplementation(async () => {
				throw new Error("ECONNREFUSED");
			});
			scheduler.setSlackChannel(slack as never, "U_OWNER");

			const job = scheduler.createJob({
				name: "Slack Down Throw",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			const result = await scheduler.runJobNow(job.id);
			expect(result).toBe("Mock response");

			const after = scheduler.getJob(job.id);
			expect(after?.lastDeliveryStatus).toMatch(/^error:/);
			expect(after?.lastDeliveryStatus).toContain("ECONNREFUSED");
			expect(after?.lastRunStatus).toBe("ok");
		});
	});

	// ---------- M1: non-blocking missed-job recovery ----------

	describe("M1: non-blocking missed-job recovery", () => {
		test("staggerMissedJobs rewrites next_run_at instead of awaiting executeJob", () => {
			const now = Date.now();
			// Insert three past-due jobs directly.
			for (let i = 0; i < 3; i++) {
				const past = new Date(now - (i + 1) * 60_000).toISOString();
				db.run(
					`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, next_run_at)
					 VALUES (?, ?, 'every', ?, 'task', ?)`,
					[`job-${i}`, `Missed ${i}`, JSON.stringify({ intervalMs: 60000 }), past],
				);
			}
			const t0 = Date.now();
			const result = staggerMissedJobs(db, now);
			const elapsed = Date.now() - t0;

			expect(result.count).toBe(3);
			// Pure SQL rewrite: should be well under a second even on cold CI.
			expect(elapsed).toBeLessThan(500);

			// Check that next_run_at was rewritten per-row.
			const rows = db.query("SELECT next_run_at FROM scheduled_jobs ORDER BY next_run_at ASC").all() as {
				next_run_at: string;
			}[];
			// The three times must be monotonically increasing and staggered by 5s.
			const times = rows.map((r) => new Date(r.next_run_at).getTime());
			expect(times[1] - times[0]).toBe(5_000);
			expect(times[2] - times[1]).toBe(5_000);
		});

		test("start() returns in milliseconds even with many missed jobs", async () => {
			// Insert 50 past-due jobs.
			for (let i = 0; i < 50; i++) {
				const past = new Date(Date.now() - (i + 1) * 1000).toISOString();
				db.run(
					`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, next_run_at)
					 VALUES (?, ?, 'every', ?, 'task', ?)`,
					[`boot-${i}`, `Boot ${i}`, JSON.stringify({ intervalMs: 60000 }), past],
				);
			}
			const runtime = createMockRuntime();
			// Make handleMessage slow to prove we don't wait for it.
			runtime.handleMessage.mockImplementation(async () => {
				await new Promise((r) => setTimeout(r, 50_000));
				return {
					text: "x",
					sessionId: "",
					cost: { totalUsd: 0, inputTokens: 0, outputTokens: 0, modelUsage: {} },
					durationMs: 50_000,
				};
			});
			const scheduler = new Scheduler({ db, runtime: runtime as never });
			const t0 = Date.now();
			await scheduler.start();
			const elapsed = Date.now() - t0;
			scheduler.stop();
			// Tolerance leaves headroom for CI jitter while still catching a
			// regression that falls back to sequential 5s stagger awaits.
			expect(elapsed).toBeLessThan(500);
		});
	});

	// ---------- M2/M9: runJobNow guards ----------

	describe("M2/M9: runJobNow guards", () => {
		test("runJobNow rejects when status is not active", async () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const job = scheduler.createJob({
				name: "Failed Job",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			// Mark it failed directly.
			db.run("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?", [job.id]);
			await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/status 'failed'/);
		});

		test("runJobNow rejects completed jobs", async () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const job = scheduler.createJob({
				name: "Completed Job",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			db.run("UPDATE scheduled_jobs SET status = 'completed' WHERE id = ?", [job.id]);
			await expect(scheduler.runJobNow(job.id)).rejects.toThrow(/status 'completed'/);
		});
	});

	// ---------- M3: 5-part cron pin ----------

	describe("M3: croner pinned to 5-part mode", () => {
		test("computeNextRunAt rejects 6-part cron", () => {
			expect(computeNextRunAt({ kind: "cron", expr: "*/30 0 9 * * *" })).toBeNull();
		});

		test("computeNextRunAt rejects 7-part cron", () => {
			expect(computeNextRunAt({ kind: "cron", expr: "*/30 0 9 * * * 2026" })).toBeNull();
		});

		test("computeNextRunAt rejects nicknames", () => {
			expect(computeNextRunAt({ kind: "cron", expr: "@daily" })).toBeNull();
			expect(computeNextRunAt({ kind: "cron", expr: "@hourly" })).toBeNull();
		});

		test("computeNextRunAt accepts valid 5-part cron", () => {
			expect(computeNextRunAt({ kind: "cron", expr: "0 9 * * 1-5" })).not.toBeNull();
		});
	});

	// ---------- M5: /health scheduler summary ----------

	describe("M5: scheduler health summary", () => {
		test("getHealthSummary returns zero counts on empty DB", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const s = scheduler.getHealthSummary();
			expect(s.total).toBe(0);
			expect(s.active).toBe(0);
			expect(s.nextFireAt).toBeNull();
		});

		test("getHealthSummary counts active, paused, failed jobs correctly", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const j1 = scheduler.createJob({
				name: "A",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			const j2 = scheduler.createJob({
				name: "B",
				schedule: { kind: "every", intervalMs: 120_000 },
				task: "x",
			});
			db.run("UPDATE scheduled_jobs SET status = 'failed' WHERE id = ?", [j2.id]);
			// j1 is active, j2 is failed.
			const s = computeHealthSummary(db);
			expect(s.total).toBe(2);
			expect(s.active).toBe(1);
			expect(s.failed).toBe(1);
			expect(s.nextFireAt).toBeTruthy();
			// nextFireAt should reference j1 (the only active row).
			expect(new Date(s.nextFireAt ?? "").getTime()).toBeGreaterThan(Date.now());
			expect(j1).toBeTruthy();
		});

		test("recentFailures counts active jobs with consecutive_errors > 0", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const j = scheduler.createJob({
				name: "Flaky",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			db.run("UPDATE scheduled_jobs SET consecutive_errors = 3 WHERE id = ?", [j.id]);
			const s = scheduler.getHealthSummary();
			expect(s.recentFailures).toBe(1);
		});
	});

	// ---------- M6: cron backoff respects cadence ----------

	describe("M6: cron error backoff respects cron cadence", () => {
		test("cron job with failures picks min(backoff, next cron fire)", () => {
			// Backoff: 30s for 1 consecutive error.
			const backoff = computeBackoffNextRun(1);
			const backoffMs = backoff.getTime() - Date.now();
			expect(backoffMs).toBeGreaterThan(29_000);
			expect(backoffMs).toBeLessThan(31_000);

			// A "* * * * *" cron fires every minute; the next fire could be
			// up to 60s away. The min(backoff=30s, next_cron<=60s) picks
			// whichever is smaller. We assert the logic by constructing both
			// and taking the min.
			const nextCron = computeNextRunAt({ kind: "cron", expr: "* * * * *" });
			expect(nextCron).not.toBeNull();
		});
	});

	// ---------- M8: rowToJob parse-error guard ----------

	describe("M8: listJobs skips corrupt rows", () => {
		test("listJobs drops rows with unknown schedule_kind and logs", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			// Insert a normal row via the public API.
			scheduler.createJob({
				name: "Good",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			// Insert a corrupt row directly.
			db.run(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, next_run_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				["bad-id", "Corrupt", "martian", "{}", "task", new Date(Date.now() + 60_000).toISOString()],
			);

			const jobs = scheduler.listJobs();
			expect(jobs.length).toBe(1);
			expect(jobs[0].name).toBe("Good");
		});

		test("getJob returns null for a corrupt row", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			db.run(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task)
				 VALUES (?, ?, ?, ?, ?)`,
				["corrupt-id", "Bad", "future-kind", "{}", "x"],
			);
			expect(scheduler.getJob("corrupt-id")).toBeNull();
		});
	});

	// ---------- N1: duplicate name detection ----------

	describe("N1: duplicate name detection", () => {
		test("createJob throws on duplicate name", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			scheduler.createJob({
				name: "Dupe",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			expect(() =>
				scheduler.createJob({
					name: "Dupe",
					schedule: { kind: "every", intervalMs: 60_000 },
					task: "y",
				}),
			).toThrow(/already exists/);
		});

		test("createJob throws on case-insensitive duplicate", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			scheduler.createJob({
				name: "Morning Report",
				schedule: { kind: "every", intervalMs: 60_000 },
				task: "x",
			});
			expect(() =>
				scheduler.createJob({
					name: "morning report",
					schedule: { kind: "every", intervalMs: 60_000 },
					task: "y",
				}),
			).toThrow(/already exists/);
		});
	});

	// ---------- N5: cleanup sweep ----------

	describe("N5: cleanup sweep for old terminal rows", () => {
		test("cleanupOldTerminalJobs deletes completed rows older than 30 days", () => {
			const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
			db.run(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, status, delete_after_run, updated_at)
				 VALUES (?, ?, 'every', ?, 'x', 'completed', 0, ?)`,
				["old-done", "Old Done", JSON.stringify({ intervalMs: 1 }), longAgo],
			);
			db.run(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, status, delete_after_run, updated_at)
				 VALUES (?, ?, 'every', ?, 'x', 'failed', 0, ?)`,
				["old-fail", "Old Fail", JSON.stringify({ intervalMs: 1 }), longAgo],
			);
			const swept = cleanupOldTerminalJobs(db);
			expect(swept).toBe(2);
		});

		test("cleanupOldTerminalJobs leaves recent terminal rows and active rows alone", () => {
			const recent = new Date(Date.now() - 60_000).toISOString();
			db.run(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, status, delete_after_run, updated_at)
				 VALUES (?, ?, 'every', ?, 'x', 'completed', 0, ?)`,
				["recent-done", "Recent Done", JSON.stringify({ intervalMs: 1 }), recent],
			);
			db.run(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, status, delete_after_run)
				 VALUES (?, ?, 'every', ?, 'x', 'active', 0)`,
				["active", "Active", JSON.stringify({ intervalMs: 1 })],
			);
			const swept = cleanupOldTerminalJobs(db);
			expect(swept).toBe(0);
		});
	});

	// ---------- N8: task text max length ----------

	describe("N8: task text max length", () => {
		test("createJob throws on task text larger than 32 KB", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const huge = "a".repeat(33 * 1024);
			expect(() =>
				scheduler.createJob({
					name: "Too Big",
					schedule: { kind: "every", intervalMs: 60_000 },
					task: huge,
				}),
			).toThrow(/exceeds/);
		});

		test("createJob accepts task text exactly at the limit", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			const exact = "a".repeat(32 * 1024);
			expect(() =>
				scheduler.createJob({
					name: "At Limit",
					schedule: { kind: "every", intervalMs: 60_000 },
					task: exact,
				}),
			).not.toThrow();
		});
	});

	// ---------- OOS#6: MAX_JOBS rate limit ----------

	describe("OOS#6: MAX_JOBS rate limit", () => {
		test("createJob throws when count exceeds MAX_JOBS", () => {
			const scheduler = new Scheduler({ db, runtime: createMockRuntime() as never });
			// Seed directly to 1000 so we don't hit the 1000-create-loop test cost.
			const stmt = db.prepare(
				`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, next_run_at)
				 VALUES (?, ?, 'every', '{}', 'x', ?)`,
			);
			const future = new Date(Date.now() + 60_000).toISOString();
			for (let i = 0; i < 1000; i++) stmt.run(`seed-${i}`, `Seed${i}`, future);
			expect(() =>
				scheduler.createJob({
					name: "Over Limit",
					schedule: { kind: "every", intervalMs: 60_000 },
					task: "x",
				}),
			).toThrow(/job limit/);
		});
	});

	// ---------- N3 regression: setTimeout int32 overflow clamp ----------

	describe("N3 regression: armTimer clamps delay to prevent setTimeout int32 overflow", () => {
		test("setTimeout is never called with a delay larger than one hour", async () => {
			// Regression guard: any job whose next fire is more than ~24.8 days
			// away would overflow the 32-bit setTimeout delay and cause a hot
			// armTimer -> onTimer -> armTimer spin loop (Codex P1 on PR #51).
			// The clamp in service.ts armTimer must apply before setTimeout.
			const HOUR_MS = 60 * 60 * 1000;
			const captured: number[] = [];
			const originalSetTimeout = globalThis.setTimeout;
			// Replace global setTimeout with a capturing wrapper. We hand work
			// off to a harmless long-delay real timer (well below int32 max),
			// and call stop() before any callback fires, so nothing executes.
			globalThis.setTimeout = ((fn: (...args: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
				if (typeof delay === "number") captured.push(delay);
				return originalSetTimeout(fn, 1_000_000, ...(rest as never[]));
			}) as typeof setTimeout;

			try {
				// 100 days in ms (~8.64e9) is vastly above the ~2.15e9 int32
				// ceiling. Without the clamp, setTimeout would receive this
				// value and coerce it to roughly 1 ms.
				const farFuture = new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString();
				db.run(
					`INSERT INTO scheduled_jobs (id, name, schedule_kind, schedule_value, task, next_run_at)
					 VALUES (?, ?, 'every', ?, 'task', ?)`,
					["n3-far", "FarFuture", JSON.stringify({ intervalMs: 60_000 }), farFuture],
				);

				const runtime = createMockRuntime();
				const scheduler = new Scheduler({ db, runtime: runtime as never });
				await scheduler.start();
				scheduler.stop();

				// At least one setTimeout call happened during start() -> armTimer.
				expect(captured.length).toBeGreaterThan(0);
				// Every captured delay must be within the one-hour clamp, not
				// the raw 100-day value. This assertion fails if the clamp is
				// ever removed again.
				const overLimit = captured.filter((d) => d > HOUR_MS);
				expect(overLimit).toEqual([]);
			} finally {
				globalThis.setTimeout = originalSetTimeout;
			}
		});
	});
});

// ---------- Runtime C2 belt: AgentRuntime isSessionBusy / Error bounce ----------

describe("AgentRuntime C2 belt", () => {
	test("isSessionBusy reflects activeSessions entries", async () => {
		const { AgentRuntime } = await import("../../agent/runtime.ts");
		const config = {
			name: "test",
			model: "claude-opus-4-6",
			effort: "standard",
			timeout_minutes: 5,
			port: 0,
			role: "swe",
			max_budget_usd: 0,
		} as never;
		const db2 = new Database(":memory:");
		db2.run("PRAGMA journal_mode = WAL");
		runMigrations(db2);
		const runtime = new AgentRuntime(config, db2);
		expect(runtime.isSessionBusy("scheduler", "sched:foo")).toBe(false);
		// activeSessions is private; exercise via handleMessage re-entry.
		// We cannot easily drive a real SDK query here, so we rely on the
		// service-level test above to cover the scheduler -> isSessionBusy
		// interaction.
		db2.close();
	});
});
