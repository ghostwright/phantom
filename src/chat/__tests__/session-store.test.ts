import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { ChatEventLog } from "../event-log.ts";
import { ChatMessageStore } from "../message-store.ts";
import { ChatSessionStore } from "../session-store.ts";

let db: Database;
let store: ChatSessionStore;

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	store = new ChatSessionStore(db);
});

afterEach(() => {
	db.close();
});

describe("ChatSessionStore", () => {
	test("create and retrieve session", () => {
		const session = store.create("Test Session");
		expect(session.id).toBeDefined();
		expect(session.title).toBe("Test Session");
		expect(session.status).toBe("active");

		const fetched = store.get(session.id);
		expect(fetched).not.toBeNull();
		expect(fetched?.title).toBe("Test Session");
	});

	test("create session without title", () => {
		const session = store.create();
		expect(session.title).toBeNull();
	});

	test("list sessions returns empty", () => {
		const result = store.list();
		expect(result.sessions).toHaveLength(0);
		expect(result.nextCursor).toBeNull();
	});

	test("list sessions with pagination", () => {
		for (let i = 0; i < 5; i++) {
			const s = store.create(`Session ${i}`);
			store.incrementMessageCount(s.id);
		}
		const page1 = store.list({ limit: 2 });
		expect(page1.sessions).toHaveLength(2);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = store.list({ limit: 2, cursor: page1.nextCursor ?? undefined });
		expect(page2.sessions).toHaveLength(2);
	});

	test("list filters by status", () => {
		store.create("Active");
		store.create("Archived");
		store.update(store.list().sessions[1].id, { status: "archived" });
		const result = store.list({ status: "active" });
		expect(result.sessions.every((s) => s.status === "active")).toBe(true);
	});

	test("update title sets title_is_manual", () => {
		const session = store.create();
		store.update(session.id, { title: "My Title" });
		const updated = store.get(session.id);
		expect(updated?.title).toBe("My Title");
		expect(updated?.title_is_manual).toBe(1);
	});

	test("update pinned", () => {
		const session = store.create();
		store.update(session.id, { pinned: true });
		const updated = store.get(session.id);
		expect(updated?.pinned).toBe(1);
	});

	test("soft delete sets deleted_at", () => {
		const session = store.create("To Delete");
		store.softDelete(session.id);
		const fetched = store.get(session.id);
		expect(fetched).toBeNull();
	});

	test("hardDeleteExpired removes old soft-deleted sessions", () => {
		const session = store.create("Old Delete");
		db.run("UPDATE chat_sessions SET deleted_at = datetime('now', '-31 days') WHERE id = ?", [session.id]);
		const count = store.hardDeleteExpired(30);
		expect(count).toBe(1);
	});

	test("fork creates new session with source reference", () => {
		const original = store.create("Original");
		const forked = store.fork(original.id, 5);
		expect(forked.forked_from_session_id).toBe(original.id);
		expect(forked.forked_from_message_seq).toBe(5);
	});

	test("incrementMessageCount increments and updates last_message_at", () => {
		const session = store.create();
		store.incrementMessageCount(session.id);
		const updated = store.get(session.id);
		expect(updated?.message_count).toBe(1);
		expect(updated?.last_message_at).not.toBeNull();
	});

	test("resetTitle clears title and manual flag", () => {
		const session = store.create();
		store.update(session.id, { title: "Manual Title" });
		store.resetTitle(session.id);
		const updated = store.get(session.id);
		expect(updated?.title).toBeNull();
		expect(updated?.title_is_manual).toBe(0);
	});

	test("setAutoTitle only sets if title is null and not manual", () => {
		const session = store.create();
		store.setAutoTitle(session.id, "Auto Title");
		const updated = store.get(session.id);
		expect(updated?.title).toBe("Auto Title");

		store.setAutoTitle(session.id, "Should Not Change");
		const unchanged = store.get(session.id);
		expect(unchanged?.title).toBe("Auto Title");
	});

	test("pinned sessions sort first", () => {
		const s1 = store.create("Unpinned");
		store.incrementMessageCount(s1.id);
		const s2 = store.create("Pinned");
		store.incrementMessageCount(s2.id);
		store.update(s2.id, { pinned: true });
		const result = store.list();
		expect(result.sessions[0].pinned).toBe(1);
	});

	test("hardDeleteExpired removes child rows without FK violation", () => {
		db.run("PRAGMA foreign_keys = ON");
		const session = store.create("FK Test");
		const messageStore = new ChatMessageStore(db);
		const eventLog = new ChatEventLog(db);
		const attachmentStore = new ChatAttachmentStore(db);

		messageStore.commit({
			sessionId: session.id,
			seq: 1,
			role: "user",
			contentJson: JSON.stringify("hello"),
		});
		eventLog.append(session.id, null, 1, "user.message", { event: "user.message" });
		attachmentStore.create({
			sessionId: session.id,
			kind: "file",
			filename: "test.txt",
			mimeType: "text/plain",
			sizeBytes: 10,
			storagePath: "/tmp/test.txt",
		});

		db.run("UPDATE chat_sessions SET deleted_at = datetime('now', '-31 days') WHERE id = ?", [session.id]);

		// Should not throw FK violation
		const count = store.hardDeleteExpired(30);
		expect(count).toBe(1);

		// Verify child rows are gone
		const messages = messageStore.getBySession(session.id);
		expect(messages).toHaveLength(0);
		const events = eventLog.drain(session.id, 0);
		expect(events).toHaveLength(0);
	});

	test("cursor pagination uses consistent sort key", () => {
		// Create sessions without messages (last_message_at is NULL)
		for (let i = 0; i < 3; i++) {
			store.create(`NullDate ${i}`);
		}
		const page1 = store.list({ limit: 2 });
		expect(page1.sessions).toHaveLength(2);
		expect(page1.nextCursor).not.toBeNull();

		// Cursor should encode created_at (not empty string) when last_message_at is null
		const cursor = page1.nextCursor ?? "";
		const cursorParts = cursor.split("|");
		expect(cursorParts[1]).not.toBe("");

		const page2 = store.list({ limit: 2, cursor: page1.nextCursor ?? undefined });
		expect(page2.sessions).toHaveLength(1);
		// No duplicates between pages
		const allIds = [...page1.sessions, ...page2.sessions].map((s) => s.id);
		expect(new Set(allIds).size).toBe(allIds.length);
	});
});
