import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { ChatSessionStore } from "../session-store.ts";
import { searchChatTranscript } from "../transcript-search.ts";

let db: Database;

function insertMessage(input: {
	id: string;
	sessionId?: string;
	seq: number;
	role: "user" | "assistant";
	content: unknown;
}): void {
	db.run(
		`INSERT INTO chat_messages (id, session_id, seq, role, content_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[
			input.id,
			input.sessionId ?? "chat-1",
			input.seq,
			input.role,
			JSON.stringify(input.content),
			`2026-05-01T00:00:0${input.seq}.000Z`,
		],
	);
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}
	db.run("INSERT INTO chat_sessions (id) VALUES ('chat-1')");
	db.run("INSERT INTO chat_sessions (id) VALUES ('chat-2')");
});

afterEach(() => {
	db.close();
});

describe("searchChatTranscript", () => {
	test("finds compact cited snippets in the current session", () => {
		insertMessage({ id: "m1", seq: 1, role: "user", content: "Build a profile page for Chima." });
		insertMessage({
			id: "m2",
			seq: 2,
			role: "assistant",
			content: "Created http://127.0.0.1:3112/ui/muhammad-ahmed-cheema.html",
		});
		insertMessage({
			id: "m3",
			sessionId: "chat-2",
			seq: 1,
			role: "assistant",
			content: "Other session with Chima should not leak.",
		});

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "cheema", limit: 5 });

		expect(result.count).toBe(1);
		expect(result.results[0]).toMatchObject({
			id: "m2",
			session_id: "chat-1",
			seq: 2,
			role: "assistant",
			citation: "chat:chat-1#msg:2",
		});
		expect(result.results[0]?.snippet).toContain("muhammad-ahmed-cheema.html");
	});

	test("lists recent entries when query is omitted", () => {
		insertMessage({ id: "m1", seq: 1, role: "user", content: "one" });
		insertMessage({ id: "m2", seq: 2, role: "assistant", content: "two" });
		insertMessage({ id: "m3", seq: 3, role: "user", content: "three" });

		const result = searchChatTranscript(db, { sessionId: "chat-1", limit: 2 });

		expect(result.query).toBeNull();
		expect(result.results.map((row) => row.seq)).toEqual([3, 2]);
	});

	test("supports role and seq filters", () => {
		insertMessage({ id: "m1", seq: 1, role: "user", content: "alpha" });
		insertMessage({ id: "m2", seq: 2, role: "assistant", content: "alpha assistant" });
		insertMessage({ id: "m3", seq: 3, role: "user", content: "alpha later" });

		const result = searchChatTranscript(db, {
			sessionId: "chat-1",
			query: "alpha",
			role: "user",
			beforeSeq: 3,
			limit: 10,
		});

		expect(result.results.map((row) => row.seq)).toEqual([1]);
	});

	test("redacts credentials, magic login tokens, and large base64 payloads", () => {
		insertMessage({
			id: "m1",
			seq: 1,
			role: "assistant",
			content: `Open http://127.0.0.1:3112/ui/login?magic=secret-token and use api_key=abc123 with ${"A".repeat(220)}`,
		});

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "open", limit: 1 });
		const snippet = result.results[0]?.snippet ?? "";

		expect(snippet).toContain("/ui/login?magic=[REDACTED]");
		expect(snippet).toContain("api_key=[REDACTED]");
		expect(snippet).toContain("[REDACTED_BLOB]");
		expect(snippet).not.toContain("secret-token");
		expect(snippet).not.toContain("abc123");
	});

	test("summarizes attachments without returning payload bytes", () => {
		insertMessage({
			id: "m1",
			seq: 1,
			role: "user",
			content: [
				{
					type: "attachment",
					id: "att-1",
					filename: "brief.pdf",
					mime_type: "application/pdf",
					size_bytes: 1234,
					preview_url: "/chat/attachments/att-1/preview",
				},
				{ type: "text", text: "Please inspect the attached brief." },
			],
		});

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "brief", limit: 1 });

		expect(result.results[0]?.attachments).toEqual([
			{ filename: "brief.pdf", mime_type: "application/pdf", size_bytes: 1234 },
		]);
		expect(result.results[0]?.snippet).toContain("[attachment: brief.pdf application/pdf]");
	});

	test("redacts credential-shaped attachment metadata in snippets and metadata", () => {
		insertMessage({
			id: "m1",
			seq: 1,
			role: "user",
			content: [
				{
					type: "attachment",
					filename: "AKIAABCDEFGHIJKLMNOP.pdf",
					mime_type: "application/x-api-key=raw-secret",
					size_bytes: 1,
					source: { data: "RAW_BASE64_PAYLOAD" },
				},
				{ type: "text", text: "alpha attachment" },
			],
		});

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "alpha", limit: 1 });
		const entry = result.results[0];

		expect(entry?.snippet).toContain("[REDACTED_AWS_KEY].pdf");
		expect(entry?.attachments).toEqual([
			{ filename: "[REDACTED_AWS_KEY].pdf", mime_type: "application/x-api-key=[REDACTED]", size_bytes: 1 },
		]);
		expect(JSON.stringify(entry)).not.toContain("AKIAABCDEFGHIJKLMNOP");
		expect(JSON.stringify(entry)).not.toContain("raw-secret");
		expect(JSON.stringify(entry)).not.toContain("RAW_BASE64_PAYLOAD");
	});

	test("does not return messages from deleted sessions", () => {
		db.run("UPDATE chat_sessions SET status = 'deleted' WHERE id = 'chat-1'");
		insertMessage({ id: "m1", seq: 1, role: "user", content: "deleted session detail" });

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "deleted", limit: 10 });

		expect(result.count).toBe(0);
	});

	test("does not return messages from soft-deleted sessions", () => {
		new ChatSessionStore(db).softDelete("chat-1");
		insertMessage({ id: "m1", seq: 1, role: "user", content: "soft deleted session detail" });

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "soft", limit: 10 });

		expect(result.count).toBe(0);
	});

	test("redacts private keys, AWS keys, and line-wrapped base64", () => {
		const wrappedBase64 = `${"A".repeat(64)}\n${"B".repeat(64)}\n${"C".repeat(64)}`;
		insertMessage({
			id: "m1",
			seq: 1,
			role: "assistant",
			content: `alpha AKIAABCDEFGHIJKLMNOP -----BEGIN PRIVATE KEY-----\nraw-private-key\n-----END PRIVATE KEY-----\n${wrappedBase64}`,
		});

		const result = searchChatTranscript(db, { sessionId: "chat-1", query: "alpha", limit: 1 });
		const snippet = result.results[0]?.snippet ?? "";

		expect(snippet).toContain("[REDACTED_AWS_KEY]");
		expect(snippet).toContain("[REDACTED_PRIVATE_KEY]");
		expect(snippet).toContain("[REDACTED_BLOB]");
		expect(snippet).not.toContain("AKIAABCDEFGHIJKLMNOP");
		expect(snippet).not.toContain("raw-private-key");
		expect(snippet).not.toContain("AAAA");
	});

	test("omits unknown structured payloads instead of stringifying them", () => {
		insertMessage({
			id: "m1",
			seq: 1,
			role: "assistant",
			content: {
				type: "unknown",
				source: { data: "RAW_BASE64_PAYLOAD" },
				api_key: "plain-secret",
			},
		});

		const result = searchChatTranscript(db, { sessionId: "chat-1", limit: 1 });
		const snippet = result.results[0]?.snippet ?? "";

		expect(snippet).toBe("[structured content omitted]");
		expect(snippet).not.toContain("RAW_BASE64_PAYLOAD");
		expect(snippet).not.toContain("plain-secret");
	});
});
