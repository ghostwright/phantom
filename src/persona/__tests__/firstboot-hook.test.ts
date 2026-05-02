// Integration test for the firstboot hook + the SQLite draft store.
// Drives the runner against a real in-memory SQLite, asserts the
// schema migrations applied, drafts persisted, ledger updated, and
// audit events fired.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { listDraftsForFire, readFirstHourLedger } from "../draft-store.ts";
import { fireFirstHourOfWorkOnFirstboot } from "../firstboot-hook.ts";
import type { LlmTurnCaller } from "../runner.ts";
import type { AuditEvent, DraftKind } from "../types.ts";

const ORIGINAL_PERSONA_ID = process.env.PHANTOM_PERSONA_ID;
const ORIGINAL_GRANTS = process.env.PHANTOM_GRANTED_INTEGRATIONS;

describe("fireFirstHourOfWorkOnFirstboot", () => {
	beforeEach(() => {
		process.env.PHANTOM_PERSONA_ID = "eng-cos-marcus";
		process.env.PHANTOM_GRANTED_INTEGRATIONS = "github";
	});

	afterEach(() => {
		if (ORIGINAL_PERSONA_ID === undefined) {
			process.env.PHANTOM_PERSONA_ID = undefined;
		} else {
			process.env.PHANTOM_PERSONA_ID = ORIGINAL_PERSONA_ID;
		}
		if (ORIGINAL_GRANTS === undefined) {
			process.env.PHANTOM_GRANTED_INTEGRATIONS = undefined;
		} else {
			process.env.PHANTOM_GRANTED_INTEGRATIONS = ORIGINAL_GRANTS;
		}
	});

	test("happy path: drafts persist to SQLite, ledger updates, all audits fire", async () => {
		const db = new Database(":memory:");
		runMigrations(db);

		const llm: LlmTurnCaller = async () => ({
			pulls_executed: [{ source: "github", query: "search/issues", rows: 5 }],
			saved_drafts: [
				{ kind: "pr_comment" as DraftKind, summary: "PR #1 review", body: "lgtm with one nit" },
				{ kind: "standup_post" as DraftKind, summary: "Standup", body: "Yesterday: X. Today: Y." },
			],
		});

		const slackCalls: { userId: string; text: string }[] = [];
		const auditEvents: AuditEvent[] = [];

		await fireFirstHourOfWorkOnFirstboot({
			db,
			slack: {
				sendBlocks: async (userId, text) => {
					slackCalls.push({ userId, text });
					return "ts.123";
				},
			},
			owner_user_id: "U_OWNER",
			tenant_slug: "fixture",
			owner_email: "owner@fixture.test",
			owner_name: "Owner",
			llm,
			audit: (e) => auditEvents.push(e),
		});

		const ledger = readFirstHourLedger(db);
		expect(ledger.first_hour_of_work_completed_at).not.toBeNull();
		expect(ledger.first_hour_of_work_reason_code).toBe("ok");
		expect(ledger.first_hour_of_work_started_at).not.toBeNull();
		expect(ledger.first_hour_of_work_fire_id).not.toBeNull();

		const fireId = ledger.first_hour_of_work_fire_id ?? "";
		const drafts = listDraftsForFire(db, fireId);
		expect(drafts).toHaveLength(2);
		expect(drafts[0].body).toContain("lgtm");
		expect(drafts[0].status).toBe("pending");
		expect(drafts[0].persona_id).toBe("eng-cos-marcus");

		expect(slackCalls).toHaveLength(1);
		const kinds = auditEvents.map((e) => e.kind);
		expect(kinds[0]).toBe("first_hour_of_work_start");
		expect(kinds[kinds.length - 1]).toBe("first_hour_of_work_finish");
	});

	test("PHANTOM_PERSONA_ID unset: hook is a no-op", async () => {
		process.env.PHANTOM_PERSONA_ID = undefined;
		const db = new Database(":memory:");
		runMigrations(db);

		const slackCalls: { userId: string }[] = [];
		const auditEvents: AuditEvent[] = [];

		await fireFirstHourOfWorkOnFirstboot({
			db,
			slack: {
				sendBlocks: async (userId) => {
					slackCalls.push({ userId });
					return "ts";
				},
			},
			owner_user_id: "U",
			tenant_slug: "f",
			owner_email: "x@y",
			llm: async () => ({ pulls_executed: [], saved_drafts: [] }),
			audit: (e) => auditEvents.push(e),
		});

		expect(slackCalls).toHaveLength(0);
		expect(auditEvents).toHaveLength(0);
		const ledger = readFirstHourLedger(db);
		expect(ledger.first_hour_of_work_completed_at).toBeNull();
	});

	test("ledger says completed: hook is a no-op (idempotent)", async () => {
		const db = new Database(":memory:");
		runMigrations(db);
		// Pre-fill the ledger as if a prior boot completed the fire.
		db.run(
			"INSERT INTO firstboot_state (id, first_hour_of_work_completed_at, first_hour_of_work_reason_code) VALUES (1, ?, ?)",
			[new Date().toISOString(), "ok"],
		);

		const slackCalls: unknown[] = [];
		const auditEvents: AuditEvent[] = [];

		await fireFirstHourOfWorkOnFirstboot({
			db,
			slack: {
				sendBlocks: async () => {
					slackCalls.push("call");
					return "ts";
				},
			},
			owner_user_id: "U",
			tenant_slug: "f",
			owner_email: "x@y",
			llm: async () => ({ pulls_executed: [], saved_drafts: [] }),
			audit: (e) => auditEvents.push(e),
		});

		expect(slackCalls).toHaveLength(0);
		expect(auditEvents).toHaveLength(0);
	});

	test("no_integrations_granted persists ledger reason and ships fallback DM", async () => {
		process.env.PHANTOM_GRANTED_INTEGRATIONS = "";
		const db = new Database(":memory:");
		runMigrations(db);

		const slackCalls: { userId: string; text: string }[] = [];
		await fireFirstHourOfWorkOnFirstboot({
			db,
			slack: {
				sendBlocks: async (userId, text) => {
					slackCalls.push({ userId, text });
					return "ts.999";
				},
			},
			owner_user_id: "U",
			tenant_slug: "f",
			owner_email: "x@y",
			llm: async () => ({ pulls_executed: [], saved_drafts: [] }),
		});

		const ledger = readFirstHourLedger(db);
		expect(ledger.first_hour_of_work_reason_code).toBe("no_integrations_granted");
		expect(slackCalls).toHaveLength(1);
		expect(slackCalls[0].text).toContain("Marcus here.");
	});
});
