import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatEventLog } from "../event-log.ts";

let db: Database;
let log: ChatEventLog;

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	// Seed a chat session for foreign key
	db.run("INSERT INTO chat_sessions (id) VALUES ('sess-1')");
	log = new ChatEventLog(db);
});

afterEach(() => {
	db.close();
});

describe("ChatEventLog", () => {
	test("append and drain round-trip", () => {
		log.append("sess-1", null, 1, "session.created", { session_id: "sess-1" });
		log.append("sess-1", null, 2, "user.message", { text: "hello" });

		const events = log.drain("sess-1", 0);
		expect(events).toHaveLength(2);
		expect(events[0].seq).toBe(1);
		expect(events[1].seq).toBe(2);
		expect(events[0].event_type).toBe("session.created");
	});

	test("drain with afterSeq filter", () => {
		log.append("sess-1", null, 1, "e1", {});
		log.append("sess-1", null, 2, "e2", {});
		log.append("sess-1", null, 3, "e3", {});

		const events = log.drain("sess-1", 2);
		expect(events).toHaveLength(1);
		expect(events[0].seq).toBe(3);
	});

	test("getMaxSeq on empty table returns 0", () => {
		expect(log.getMaxSeq("sess-1")).toBe(0);
	});

	test("getMaxSeq returns highest seq", () => {
		log.append("sess-1", null, 5, "e1", {});
		log.append("sess-1", null, 10, "e2", {});
		expect(log.getMaxSeq("sess-1")).toBe(10);
	});

	test("sweep removes old events", () => {
		log.append("sess-1", null, 1, "old", {});
		db.run("UPDATE chat_stream_events SET created_at = datetime('now', '-25 hours') WHERE seq = 1");
		log.append("sess-1", null, 2, "new", {});

		const swept = log.sweep(24);
		expect(swept).toBe(1);

		const remaining = log.drain("sess-1", 0);
		expect(remaining).toHaveLength(1);
		expect(remaining[0].seq).toBe(2);
	});

	test("deleteBySession removes all events for session", () => {
		log.append("sess-1", null, 1, "e1", {});
		log.append("sess-1", null, 2, "e2", {});

		const deleted = log.deleteBySession("sess-1");
		expect(deleted).toBe(2);

		const remaining = log.drain("sess-1", 0);
		expect(remaining).toHaveLength(0);
	});

	test("drain with limit", () => {
		for (let i = 1; i <= 10; i++) {
			log.append("sess-1", null, i, `e${i}`, {});
		}
		const events = log.drain("sess-1", 0, 3);
		expect(events).toHaveLength(3);
	});

	test("payload_json is valid JSON", () => {
		const payload = { key: "value", nested: { num: 42 } };
		log.append("sess-1", null, 1, "test", payload);
		const events = log.drain("sess-1", 0);
		const parsed = JSON.parse(events[0].payload_json);
		expect(parsed.key).toBe("value");
		expect(parsed.nested.num).toBe(42);
	});
});
