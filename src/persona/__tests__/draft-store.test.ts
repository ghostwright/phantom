// Tests for the SQLite draft store and firstboot ledger helpers.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import {
	getDraftById,
	listDraftsForFire,
	markFirstHourCompleted,
	markFirstHourStarted,
	persistDraft,
	readFirstHourLedger,
} from "../draft-store.ts";

function makeDb(): Database {
	const db = new Database(":memory:");
	runMigrations(db);
	return db;
}

describe("firstboot ledger helpers", () => {
	test("readFirstHourLedger on a fresh db returns null fields", () => {
		const db = makeDb();
		const row = readFirstHourLedger(db);
		expect(row.first_hour_of_work_started_at).toBeNull();
		expect(row.first_hour_of_work_completed_at).toBeNull();
		expect(row.first_hour_of_work_reason_code).toBeNull();
		expect(row.first_hour_of_work_fire_id).toBeNull();
	});

	test("markFirstHourStarted sets started_at + fire_id", () => {
		const db = makeDb();
		markFirstHourStarted(db, "fire_abc");
		const row = readFirstHourLedger(db);
		expect(row.first_hour_of_work_started_at).not.toBeNull();
		expect(row.first_hour_of_work_fire_id).toBe("fire_abc");
	});

	test("markFirstHourCompleted sets completed_at + reason", () => {
		const db = makeDb();
		markFirstHourStarted(db, "fire_abc");
		markFirstHourCompleted(db, "ok");
		const row = readFirstHourLedger(db);
		expect(row.first_hour_of_work_completed_at).not.toBeNull();
		expect(row.first_hour_of_work_reason_code).toBe("ok");
		// started_at preserved across the completed update.
		expect(row.first_hour_of_work_fire_id).toBe("fire_abc");
	});
});

describe("phantom_drafts helpers", () => {
	test("persistDraft + listDraftsForFire round-trip", () => {
		const db = makeDb();
		const now = new Date().toISOString();
		persistDraft(db, {
			draft_id: "dft_1",
			fire_id: "fire_a",
			persona_id: "sdr-lilian",
			kind: "slack_reply",
			summary: "Reply to Acme",
			body: "Hi Sarah",
			reference_url: "https://example.com",
			edit_hints: "tighten the ask",
			status: "pending",
			created_at: now,
			updated_at: now,
		});
		const list = listDraftsForFire(db, "fire_a");
		expect(list).toHaveLength(1);
		expect(list[0].draft_id).toBe("dft_1");
		expect(list[0].body).toBe("Hi Sarah");
		expect(list[0].status).toBe("pending");
	});

	test("getDraftById returns null for unknown id", () => {
		const db = makeDb();
		expect(getDraftById(db, "nope")).toBeNull();
	});

	test("listDraftsForFire orders by created_at", () => {
		const db = makeDb();
		const t1 = "2026-05-03T09:00:00.000Z";
		const t2 = "2026-05-03T09:00:01.000Z";
		persistDraft(db, {
			draft_id: "b",
			fire_id: "f",
			persona_id: "x",
			kind: "slack_reply",
			summary: "b",
			body: "b",
			status: "pending",
			created_at: t2,
			updated_at: t2,
		});
		persistDraft(db, {
			draft_id: "a",
			fire_id: "f",
			persona_id: "x",
			kind: "slack_reply",
			summary: "a",
			body: "a",
			status: "pending",
			created_at: t1,
			updated_at: t1,
		});
		const list = listDraftsForFire(db, "f");
		expect(list[0].draft_id).toBe("a");
		expect(list[1].draft_id).toBe("b");
	});

	test("persistDraft upserts on draft_id conflict", () => {
		const db = makeDb();
		const ts = "2026-05-03T10:00:00.000Z";
		persistDraft(db, {
			draft_id: "dft_x",
			fire_id: "f",
			persona_id: "x",
			kind: "slack_reply",
			summary: "v1",
			body: "v1",
			status: "pending",
			created_at: ts,
			updated_at: ts,
		});
		persistDraft(db, {
			draft_id: "dft_x",
			fire_id: "f",
			persona_id: "x",
			kind: "slack_reply",
			summary: "v2",
			body: "v2",
			status: "pending",
			created_at: ts,
			updated_at: "2026-05-03T11:00:00.000Z",
		});
		const list = listDraftsForFire(db, "f");
		expect(list).toHaveLength(1);
		expect(list[0].body).toBe("v2");
	});
});
