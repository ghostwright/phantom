import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import { SessionStore } from "../session-store.ts";

let db: Database;
let store: SessionStore;

beforeEach(() => {
	db = new Database(":memory:");
	db.run("PRAGMA journal_mode = WAL");
	db.run("PRAGMA foreign_keys = ON");
	runMigrations(db);
	store = new SessionStore(db);
});

describe("SessionStore", () => {
	test("creates a new session", () => {
		const session = store.create("cli", "conv-1");
		expect(session.session_key).toBe("cli:conv-1");
		expect(session.channel_id).toBe("cli");
		expect(session.conversation_id).toBe("conv-1");
		expect(session.status).toBe("active");
		expect(session.total_cost_usd).toBe(0);
	});

	test("finds an active session", () => {
		store.create("cli", "conv-1");
		const found = store.findActive("cli", "conv-1");
		expect(found).not.toBeNull();
		expect(found?.session_key).toBe("cli:conv-1");
	});

	test("returns null for non-existent session", () => {
		const found = store.findActive("cli", "missing");
		expect(found).toBeNull();
	});

	test("updates SDK session ID", () => {
		store.create("cli", "conv-1");
		store.updateSdkSessionId("cli:conv-1", "sdk-abc-123");
		const session = store.getByKey("cli:conv-1");
		expect(session?.sdk_session_id).toBe("sdk-abc-123");
	});

	test("expires a session", () => {
		store.create("cli", "conv-1");
		store.expire("cli:conv-1");
		const found = store.findActive("cli", "conv-1");
		expect(found).toBeNull();

		const raw = store.getByKey("cli:conv-1");
		expect(raw?.status).toBe("expired");
	});

	test("touches a session to update last_active_at", () => {
		store.create("cli", "conv-1");
		const before = store.getByKey("cli:conv-1");
		store.touch("cli:conv-1");
		const after = store.getByKey("cli:conv-1");
		expect(after?.last_active_at).toBeDefined();
		expect(before?.last_active_at).toBeDefined();
	});

	test("clears SDK session ID", () => {
		store.create("cli", "conv-1");
		store.updateSdkSessionId("cli:conv-1", "sdk-abc-123");
		expect(store.getByKey("cli:conv-1")?.sdk_session_id).toBe("sdk-abc-123");

		store.clearSdkSessionId("cli:conv-1");
		const session = store.getByKey("cli:conv-1");
		expect(session?.sdk_session_id).toBeNull();
		expect(session?.status).toBe("active");
	});

	test("clearAllSdkSessionIds clears every stale SDK ID", () => {
		store.create("cli", "conv-1");
		store.create("slack", "conv-2");
		store.create("web", "conv-3");

		store.updateSdkSessionId("cli:conv-1", "sdk-aaa");
		store.updateSdkSessionId("slack:conv-2", "sdk-bbb");
		// web:conv-3 has no SDK session ID

		const cleared = store.clearAllSdkSessionIds();
		expect(cleared).toBe(2);

		expect(store.getByKey("cli:conv-1")?.sdk_session_id).toBeNull();
		expect(store.getByKey("slack:conv-2")?.sdk_session_id).toBeNull();
		expect(store.getByKey("web:conv-3")?.sdk_session_id).toBeNull();
	});

	test("clearAllSdkSessionIds returns 0 when no sessions have SDK IDs", () => {
		store.create("cli", "conv-1");
		const cleared = store.clearAllSdkSessionIds();
		expect(cleared).toBe(0);
	});

	test("create reactivates an expired session with the same key", () => {
		store.create("cli", "conv-1");
		store.updateSdkSessionId("cli:conv-1", "old-sdk-id");
		store.expire("cli:conv-1");

		expect(store.findActive("cli", "conv-1")).toBeNull();

		// Creating again should reactivate, not throw UNIQUE constraint error
		const reactivated = store.create("cli", "conv-1");
		expect(reactivated.status).toBe("active");
		expect(reactivated.sdk_session_id).toBeNull();
		expect(reactivated.session_key).toBe("cli:conv-1");
	});
});
