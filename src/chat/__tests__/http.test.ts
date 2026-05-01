import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { createSession } from "../../ui/session.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { ChatEventLog } from "../event-log.ts";
import { createChatHandler } from "../http.ts";
import { ChatMessageStore } from "../message-store.ts";
import { ChatRunTimelineStore } from "../run-timeline.ts";
import { ChatSessionStore } from "../session-store.ts";
import { StreamBus } from "../stream-bus.ts";

let db: Database;
let handler: (req: Request) => Promise<Response | null>;
let sessionToken: string;

function makeAuthReq(path: string, opts: RequestInit = {}): Request {
	return new Request(`http://localhost:3100${path}`, {
		...opts,
		headers: {
			...(opts.headers ?? {}),
			Cookie: `phantom_session=${sessionToken}`,
			"Content-Type": "application/json",
		},
	});
}

function makeUnauthReq(path: string, opts: RequestInit = {}): Request {
	return new Request(`http://localhost:3100${path}`, {
		...opts,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	db = new Database(":memory:");
	for (const sql of MIGRATIONS) {
		db.run(sql);
	}

	const { sessionToken: token } = createSession();
	sessionToken = token;

	const mockRuntime = {} as Parameters<typeof createChatHandler>[0]["runtime"];
	handler = createChatHandler({
		runtime: mockRuntime,
		sessionStore: new ChatSessionStore(db),
		messageStore: new ChatMessageStore(db),
		eventLog: new ChatEventLog(db),
		timelineStore: new ChatRunTimelineStore(db),
		attachmentStore: new ChatAttachmentStore(db),
		streamBus: new StreamBus(),
		getBootstrapData: () => ({ agent_name: "TestAgent", evolution_gen: 0 }),
	});
});

afterEach(() => {
	db.close();
});

describe("Chat HTTP handlers", () => {
	test("GET /chat/bootstrap returns bootstrap data", async () => {
		const res = await handler(makeAuthReq("/chat/bootstrap"));
		expect(res?.status).toBe(200);
		const body = await res?.json();
		expect(body.agent_name).toBe("TestAgent");
		expect(body.push_notifications_enabled).toBe(false);
	});

	test("POST /chat/sessions creates a session", async () => {
		const res = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({ title: "test" }),
			}),
		);
		expect(res?.status).toBe(201);
		const body = await res?.json();
		expect(body.id).toBeDefined();
		expect(body.created_at).toBeDefined();
	});

	test("GET /chat/sessions returns empty list", async () => {
		const res = await handler(makeAuthReq("/chat/sessions"));
		expect(res?.status).toBe(200);
		const body = await res?.json();
		expect(body.sessions).toHaveLength(0);
		expect(body.next_cursor).toBeNull();
	});

	test("GET /chat/sessions returns sessions after create", async () => {
		await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const res = await handler(makeAuthReq("/chat/sessions"));
		const body = await res?.json();
		expect(body.sessions.length).toBeGreaterThan(0);
	});

	test("GET /chat/sessions/:id returns session detail", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({ title: "detail test" }),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		const res = await handler(makeAuthReq(`/chat/sessions/${id}`));
		expect(res?.status).toBe(200);
		const body = await res?.json();
		expect(body.title).toBe("detail test");
	});

	test("GET /chat/sessions/:id returns stream state and durable timelines", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({ title: "stream state" }),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;
		const messageStore = new ChatMessageStore(db);
		const eventLog = new ChatEventLog(db);
		const timelineStore = new ChatRunTimelineStore(db);
		messageStore.commit({ id: "user-1", sessionId: id, seq: 1, role: "user", contentJson: JSON.stringify("hello") });
		eventLog.append(id, null, 1, "user.message", { event: "user.message", message_id: "user-1" });
		eventLog.append(id, null, 2, "message.assistant_start", {
			event: "message.assistant_start",
			message_id: "assistant-1",
			parent_tool_use_id: null,
		});
		timelineStore.upsert({
			id: "user-1",
			sessionId: id,
			userMessageId: "user-1",
			startSeq: 1,
			status: "working",
			startedAt: "2026-04-30T00:00:00.000Z",
			currentLabel: "Using Bash...",
			summary: {
				schemaVersion: 1,
				status: "working",
				startSeq: 1,
				endSeq: null,
				startedAt: "2026-04-30T00:00:00.000Z",
				currentLabel: "Using Bash...",
				tools: [],
				subagents: [],
				errors: [],
			},
		});

		const res = await handler(makeAuthReq(`/chat/sessions/${id}`));
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as {
			stream_state: {
				max_seq: number;
				latest_terminal_seq: number;
				writer_active: boolean;
				has_incomplete_tail: boolean;
			};
			run_timelines: Array<{ user_message_id: string; summary: { status: string; currentLabel?: string } }>;
		};

		expect(body.stream_state).toEqual({
			max_seq: 2,
			latest_terminal_seq: 0,
			writer_active: false,
			has_incomplete_tail: true,
		});
		expect(body.run_timelines[0]?.user_message_id).toBe("user-1");
		expect(body.run_timelines[0]?.summary.status).toBe("working");
	});

	test("GET /chat/sessions/:id returns durable attachment transcript metadata", async () => {
		const sessionStore = new ChatSessionStore(db);
		const messageStore = new ChatMessageStore(db);
		const attachmentStore = new ChatAttachmentStore(db);
		const session = sessionStore.create();
		const attachmentId = attachmentStore.create({
			id: "att-1",
			sessionId: session.id,
			kind: "pdf",
			filename: "brief.pdf",
			mimeType: "application/pdf",
			sizeBytes: 1234,
			storagePath: "/tmp/brief.pdf",
		});
		messageStore.commit({
			id: "user-1",
			sessionId: session.id,
			seq: 1,
			role: "user",
			contentJson: JSON.stringify([
				{
					type: "attachment",
					id: attachmentId,
					filename: "brief.pdf",
					mime_type: "application/pdf",
					size_bytes: 1234,
					preview_url: `/chat/attachments/${attachmentId}/preview`,
				},
				{ type: "text", text: "Review this." },
			]),
		});
		attachmentStore.commitToMessage(attachmentId, "user-1");

		const res = await handler(makeAuthReq(`/chat/sessions/${session.id}`));
		expect(res?.status).toBe(200);
		const body = (await res?.json()) as { messages: Array<{ content_json: string }> };
		const content = JSON.parse(body.messages[0]?.content_json ?? "[]") as Array<Record<string, unknown>>;
		expect(content[0]).toMatchObject({
			type: "attachment",
			id: "att-1",
			filename: "brief.pdf",
			mime_type: "application/pdf",
			size_bytes: 1234,
		});
	});

	test("GET /chat/sessions/:id returns 404 for missing session", async () => {
		const res = await handler(makeAuthReq("/chat/sessions/nonexistent"));
		expect(res?.status).toBe(404);
	});

	test("DELETE /chat/sessions/:id soft-deletes", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		const res = await handler(makeAuthReq(`/chat/sessions/${id}`, { method: "DELETE" }));
		expect(res?.status).toBe(200);
		const body = await res?.json();
		expect(body.ok).toBe(true);
		expect(body.undo_until).toBeDefined();

		const getRes = await handler(makeAuthReq(`/chat/sessions/${id}`));
		expect(getRes?.status).toBe(404);
	});

	test("PATCH /chat/sessions/:id renames", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		const res = await handler(
			makeAuthReq(`/chat/sessions/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "New Name" }),
			}),
		);
		expect(res?.status).toBe(200);

		const getRes = await handler(makeAuthReq(`/chat/sessions/${id}`));
		const body = await getRes?.json();
		expect(body.title).toBe("New Name");
	});

	test("401 for missing cookie", async () => {
		const res = await handler(makeUnauthReq("/chat/sessions"));
		expect(res?.status).toBe(401);
	});

	test("401 for expired cookie", async () => {
		const req = new Request("http://localhost:3100/chat/sessions", {
			headers: { Cookie: "phantom_session=invalid_token_xyz" },
		});
		const res = await handler(req);
		expect(res?.status).toBe(401);
	});

	test("POST /chat/sessions/:id/title/reset resets title", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({ title: "Named" }),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		await handler(
			makeAuthReq(`/chat/sessions/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ title: "Manual" }),
			}),
		);

		const res = await handler(makeAuthReq(`/chat/sessions/${id}/title/reset`, { method: "POST" }));
		expect(res?.status).toBe(200);

		const getRes = await handler(makeAuthReq(`/chat/sessions/${id}`));
		const body = await getRes?.json();
		expect(body.title).toBeNull();
	});

	test("POST /chat/sessions/:id/fork forks a session", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		const res = await handler(
			makeAuthReq(`/chat/sessions/${id}/fork`, {
				method: "POST",
				body: JSON.stringify({ from_message_seq: 3 }),
			}),
		);
		expect(res?.status).toBe(201);
		const body = await res?.json();
		expect(body.forked_from_session_id).toBe(id);
	});

	test("unauthenticated static file request returns 401", async () => {
		const res = await handler(makeUnauthReq("/chat/index.html"));
		expect(res?.status).toBe(401);
	});

	test("unauthenticated HTML request redirects to login", async () => {
		const req = new Request("http://localhost:3100/chat/index.html", {
			headers: { Accept: "text/html,application/xhtml+xml" },
		});
		const res = await handler(req);
		expect(res?.status).toBe(302);
	});

	test("PATCH with invalid status returns 400", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		const res = await handler(
			makeAuthReq(`/chat/sessions/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ status: "bogus_value" }),
			}),
		);
		expect(res?.status).toBe(400);
	});

	test("PATCH with valid status succeeds", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const created = (await createRes?.json()) as { id: string };
		const id = created.id;

		const res = await handler(
			makeAuthReq(`/chat/sessions/${id}`, {
				method: "PATCH",
				body: JSON.stringify({ status: "archived" }),
			}),
		);
		expect(res?.status).toBe(200);
	});

	test("POST /chat/stream rejects invalid attachment ids", async () => {
		const createRes = await handler(
			makeAuthReq("/chat/sessions", {
				method: "POST",
				body: JSON.stringify({}),
			}),
		);
		const created = (await createRes?.json()) as { id: string };

		const res = await handler(
			makeAuthReq("/chat/stream", {
				method: "POST",
				body: JSON.stringify({
					session_id: created.id,
					text: "Use the attached file.",
					attachment_ids: ["missing-attachment"],
				}),
			}),
		);

		expect(res?.status).toBe(400);
		const body = await res?.json();
		expect(body.error).toBe("attachment_not_found");
	});
});
