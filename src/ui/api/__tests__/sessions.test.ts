import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { handleUiRequest, setDashboardDb, setPublicDir } from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let db: Database;
let sessionToken: string;

function runMigrations(target: Database): void {
	for (const migration of MIGRATIONS) {
		try {
			target.run(migration);
		} catch {
			// ignore ALTER TABLE duplicate failures
		}
	}
}

function seedSession(
	target: Database,
	row: {
		session_key: string;
		sdk_session_id?: string | null;
		channel_id: string;
		conversation_id: string;
		status?: string;
		total_cost_usd?: number;
		input_tokens?: number;
		output_tokens?: number;
		turn_count?: number;
		created_at?: string;
		last_active_at?: string;
	},
): void {
	target
		.query(
			`INSERT INTO sessions (session_key, sdk_session_id, channel_id, conversation_id, status,
				total_cost_usd, input_tokens, output_tokens, turn_count, created_at, last_active_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.session_key,
			row.sdk_session_id ?? null,
			row.channel_id,
			row.conversation_id,
			row.status ?? "active",
			row.total_cost_usd ?? 0,
			row.input_tokens ?? 0,
			row.output_tokens ?? 0,
			row.turn_count ?? 0,
			row.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
			row.last_active_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
		);
}

function seedCostEvent(
	target: Database,
	row: {
		session_key: string;
		cost_usd: number;
		input_tokens: number;
		output_tokens: number;
		model: string;
		created_at?: string;
	},
): void {
	target
		.query(
			`INSERT INTO cost_events (session_key, cost_usd, input_tokens, output_tokens, model, created_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.session_key,
			row.cost_usd,
			row.input_tokens,
			row.output_tokens,
			row.model,
			row.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
		);
}

function seedChatSession(
	target: Database,
	row: {
		id: string;
		title?: string | null;
		message_count?: number;
		pinned?: number;
		deleted_at?: string | null;
		forked_from_session_id?: string | null;
		forked_from_message_seq?: number | null;
	},
): void {
	target
		.query(
			`INSERT INTO chat_sessions (id, title, message_count, pinned, deleted_at,
				forked_from_session_id, forked_from_message_seq)
				VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.title ?? null,
			row.message_count ?? 0,
			row.pinned ?? 0,
			row.deleted_at ?? null,
			row.forked_from_session_id ?? null,
			row.forked_from_message_seq ?? null,
		);
}

function relativeHours(h: number): string {
	const d = new Date(Date.now() - h * 3600 * 1000);
	return d.toISOString().replace("T", " ").slice(0, 19);
}

function relativeDays(days: number): string {
	return relativeHours(days * 24);
}

beforeEach(() => {
	db = new Database(":memory:");
	runMigrations(db);
	setDashboardDb(db);
	sessionToken = createSession().sessionToken;
});

afterEach(() => {
	db.close();
	revokeAllSessions();
});

function req(path: string, init?: RequestInit): Request {
	return new Request(`http://localhost${path}`, {
		...init,
		headers: {
			Cookie: `phantom_session=${encodeURIComponent(sessionToken)}`,
			Accept: "application/json",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

describe("sessions API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/sessions", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("GET list with no filters returns all sessions sorted by last_active_at DESC", async () => {
		seedSession(db, {
			session_key: "slack:C04X:100",
			channel_id: "slack",
			conversation_id: "C04X/100",
			last_active_at: relativeHours(2),
		});
		seedSession(db, {
			session_key: "slack:C04X:200",
			channel_id: "slack",
			conversation_id: "C04X/200",
			last_active_at: relativeHours(1),
		});
		seedSession(db, {
			session_key: "chat:abc",
			channel_id: "chat",
			conversation_id: "abc",
			last_active_at: relativeHours(5),
		});

		const res = await handleUiRequest(req("/ui/api/sessions?days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ session_key: string }> };
		expect(body.sessions.length).toBe(3);
		expect(body.sessions[0].session_key).toBe("slack:C04X:200");
		expect(body.sessions[1].session_key).toBe("slack:C04X:100");
		expect(body.sessions[2].session_key).toBe("chat:abc");
	});

	test("filter by channel=slack returns only slack rows", async () => {
		seedSession(db, { session_key: "slack:A:1", channel_id: "slack", conversation_id: "A/1" });
		seedSession(db, { session_key: "chat:B", channel_id: "chat", conversation_id: "B" });
		seedSession(db, { session_key: "slack:A:2", channel_id: "slack", conversation_id: "A/2" });

		const res = await handleUiRequest(req("/ui/api/sessions?channel=slack&days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ channel_id: string }> };
		expect(body.sessions.length).toBe(2);
		expect(body.sessions.every((s) => s.channel_id === "slack")).toBe(true);
	});

	test("filter by channel=all returns all rows", async () => {
		seedSession(db, { session_key: "slack:A:1", channel_id: "slack", conversation_id: "A/1" });
		seedSession(db, { session_key: "chat:B", channel_id: "chat", conversation_id: "B" });

		const res = await handleUiRequest(req("/ui/api/sessions?channel=all&days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: unknown[] };
		expect(body.sessions.length).toBe(2);
	});

	test("filter by days=7 excludes older sessions", async () => {
		seedSession(db, {
			session_key: "recent",
			channel_id: "slack",
			conversation_id: "r",
			last_active_at: relativeDays(2),
		});
		seedSession(db, {
			session_key: "old",
			channel_id: "slack",
			conversation_id: "o",
			last_active_at: relativeDays(20),
		});

		const res = await handleUiRequest(req("/ui/api/sessions?days=7"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ session_key: string }> };
		expect(body.sessions.length).toBe(1);
		expect(body.sessions[0].session_key).toBe("recent");
	});

	test("filter by status=active excludes expired", async () => {
		seedSession(db, {
			session_key: "active:1",
			channel_id: "slack",
			conversation_id: "a1",
			status: "active",
		});
		seedSession(db, {
			session_key: "expired:1",
			channel_id: "slack",
			conversation_id: "e1",
			status: "expired",
		});

		const res = await handleUiRequest(req("/ui/api/sessions?status=active&days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ status: string }> };
		expect(body.sessions.length).toBe(1);
		expect(body.sessions[0].status).toBe("active");
	});

	test("filter by q matches conversation_id case insensitively", async () => {
		seedSession(db, {
			session_key: "slack:Match:1",
			channel_id: "slack",
			conversation_id: "MatchThis",
		});
		seedSession(db, {
			session_key: "slack:Other:1",
			channel_id: "slack",
			conversation_id: "OtherThread",
		});

		const res = await handleUiRequest(req("/ui/api/sessions?q=match&days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ session_key: string }> };
		expect(body.sessions.length).toBe(1);
		expect(body.sessions[0].session_key).toBe("slack:Match:1");
	});

	test("filter by q matches session_key case insensitively", async () => {
		seedSession(db, {
			session_key: "NEEDLE:abc",
			channel_id: "slack",
			conversation_id: "abc",
		});
		seedSession(db, {
			session_key: "haystack:def",
			channel_id: "slack",
			conversation_id: "def",
		});

		const res = await handleUiRequest(req("/ui/api/sessions?q=NEEDLE&days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: Array<{ session_key: string }> };
		expect(body.sessions.length).toBe(1);
		expect(body.sessions[0].session_key).toBe("NEEDLE:abc");
	});

	test("summary totals are correct", async () => {
		seedSession(db, {
			session_key: "s1",
			channel_id: "slack",
			conversation_id: "1",
			total_cost_usd: 1.5,
			turn_count: 4,
			status: "active",
		});
		seedSession(db, {
			session_key: "s2",
			channel_id: "slack",
			conversation_id: "2",
			total_cost_usd: 2.5,
			turn_count: 8,
			status: "expired",
		});
		seedSession(db, {
			session_key: "s3",
			channel_id: "chat",
			conversation_id: "3",
			total_cost_usd: 1.0,
			turn_count: 6,
			status: "active",
		});

		const res = await handleUiRequest(req("/ui/api/sessions?days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: {
				total_sessions: number;
				total_cost_usd: number;
				avg_turns: number;
				active_count: number;
			};
		};
		expect(body.summary.total_sessions).toBe(3);
		expect(body.summary.total_cost_usd).toBeCloseTo(5.0, 2);
		expect(body.summary.avg_turns).toBeCloseTo(6.0, 2);
		expect(body.summary.active_count).toBe(2);
	});

	test("summary fields are 0 (not null) when no rows match", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "1" });

		const res = await handleUiRequest(req("/ui/api/sessions?channel=email"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: {
				total_sessions: number;
				total_cost_usd: number;
				avg_turns: number;
				active_count: number;
			};
		};
		expect(body.summary.total_sessions).toBe(0);
		expect(body.summary.total_cost_usd).toBe(0);
		expect(body.summary.avg_turns).toBe(0);
		expect(body.summary.active_count).toBe(0);
	});

	test("summary by_channel groups correctly", async () => {
		seedSession(db, {
			session_key: "s1",
			channel_id: "slack",
			conversation_id: "1",
			total_cost_usd: 1.0,
		});
		seedSession(db, {
			session_key: "s2",
			channel_id: "slack",
			conversation_id: "2",
			total_cost_usd: 2.0,
		});
		seedSession(db, {
			session_key: "s3",
			channel_id: "chat",
			conversation_id: "3",
			total_cost_usd: 0.5,
		});

		const res = await handleUiRequest(req("/ui/api/sessions?days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: { by_channel: Array<{ channel_id: string; count: number; cost_usd: number }> };
		};
		const bySlack = body.summary.by_channel.find((b) => b.channel_id === "slack");
		const byChat = body.summary.by_channel.find((b) => b.channel_id === "chat");
		expect(bySlack).toBeDefined();
		expect(bySlack?.count).toBe(2);
		expect(bySlack?.cost_usd).toBeCloseTo(3.0, 2);
		expect(byChat).toBeDefined();
		expect(byChat?.count).toBe(1);
		expect(byChat?.cost_usd).toBeCloseTo(0.5, 2);
	});

	test("chat enrichment: chat session returns chat object", async () => {
		seedChatSession(db, {
			id: "chat-abc",
			title: "Refactoring the scheduler",
			message_count: 12,
			pinned: 1,
			deleted_at: null,
			forked_from_session_id: "chat-parent",
			forked_from_message_seq: 3,
		});
		seedSession(db, {
			session_key: "chat:chat-abc",
			channel_id: "chat",
			conversation_id: "chat-abc",
		});

		const res = await handleUiRequest(req("/ui/api/sessions?days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			sessions: Array<{ channel_id: string; chat?: Record<string, unknown> }>;
		};
		expect(body.sessions.length).toBe(1);
		const chatSession = body.sessions[0];
		expect(chatSession.chat).toBeDefined();
		expect(chatSession.chat?.title).toBe("Refactoring the scheduler");
		expect(chatSession.chat?.message_count).toBe(12);
		expect(chatSession.chat?.pinned).toBe(true);
		expect(chatSession.chat?.deleted_at).toBeNull();
		expect(chatSession.chat?.forked_from_session_id).toBe("chat-parent");
		expect(chatSession.chat?.forked_from_message_seq).toBe(3);
	});

	test("non-chat session does NOT include chat", async () => {
		seedSession(db, {
			session_key: "slack:X:1",
			channel_id: "slack",
			conversation_id: "X/1",
		});

		const res = await handleUiRequest(req("/ui/api/sessions?days=all"));
		const body = (await res.json()) as { sessions: Array<{ chat?: unknown }> };
		expect(body.sessions.length).toBe(1);
		expect(body.sessions[0].chat).toBeUndefined();
	});

	test("GET detail by session_key returns session + cost_events", async () => {
		seedSession(db, {
			session_key: "slack:C:1",
			channel_id: "slack",
			conversation_id: "C/1",
			total_cost_usd: 0.5,
		});
		seedCostEvent(db, {
			session_key: "slack:C:1",
			cost_usd: 0.2,
			input_tokens: 100,
			output_tokens: 50,
			model: "claude-opus-4-7",
			created_at: relativeHours(3),
		});
		seedCostEvent(db, {
			session_key: "slack:C:1",
			cost_usd: 0.3,
			input_tokens: 200,
			output_tokens: 80,
			model: "claude-opus-4-7",
			created_at: relativeHours(1),
		});

		const res = await handleUiRequest(req(`/ui/api/sessions/${encodeURIComponent("slack:C:1")}`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			session: { session_key: string; total_cost_usd: number };
			cost_events: Array<{ cost_usd: number }>;
		};
		expect(body.session.session_key).toBe("slack:C:1");
		expect(body.cost_events.length).toBe(2);
		// Events sorted ASC by created_at.
		expect(body.cost_events[0].cost_usd).toBeCloseTo(0.2, 2);
		expect(body.cost_events[1].cost_usd).toBeCloseTo(0.3, 2);
	});

	test("GET detail by missing key returns 404", async () => {
		const res = await handleUiRequest(req(`/ui/api/sessions/${encodeURIComponent("does-not-exist")}`));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("Session not found");
	});

	test("SQL injection attempt on q is parameterized", async () => {
		seedSession(db, {
			session_key: "normal:1",
			channel_id: "slack",
			conversation_id: "safe",
		});
		// Verify the sessions table exists before the attack.
		const beforeCount = (db.query("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
		expect(beforeCount).toBe(1);

		const payload = "x'; DROP TABLE sessions; --";
		const res = await handleUiRequest(req(`/ui/api/sessions?q=${encodeURIComponent(payload)}&days=all`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { sessions: unknown[] };
		// No rows match the literal payload.
		expect(body.sessions.length).toBe(0);

		// Critical: the sessions table still exists (the payload was treated as a literal).
		const afterCount = (db.query("SELECT COUNT(*) as n FROM sessions").get() as { n: number }).n;
		expect(afterCount).toBe(1);
	});

	test("invalid days value returns 422", async () => {
		const res = await handleUiRequest(req("/ui/api/sessions?days=999"));
		expect(res.status).toBe(422);
	});

	test("invalid status value returns 422", async () => {
		const res = await handleUiRequest(req("/ui/api/sessions?status=bogus"));
		expect(res.status).toBe(422);
	});

	test("q over max length returns 422", async () => {
		const long = "a".repeat(101);
		const res = await handleUiRequest(req(`/ui/api/sessions?q=${long}`));
		expect(res.status).toBe(422);
	});

	test("POST on sessions returns 405", async () => {
		const res = await handleUiRequest(
			req("/ui/api/sessions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			}),
		);
		expect(res.status).toBe(405);
	});
});
