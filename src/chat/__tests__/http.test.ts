import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../../db/schema.ts";
import { createSession } from "../../ui/session.ts";
import { ChatAttachmentStore } from "../attachment-store.ts";
import { ChatEventLog } from "../event-log.ts";
import { createChatHandler } from "../http.ts";
import { ChatMessageStore } from "../message-store.ts";
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
});
