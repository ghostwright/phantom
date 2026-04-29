// UI API routes for the sessions dashboard tab.
//
// All routes live under /ui/api/sessions and are cookie-auth gated by the
// dispatcher in src/ui/serve.ts.
//
//   GET  /ui/api/sessions?channel=&days=&status=&q=   -> list + summary
//   GET  /ui/api/sessions/:session_key                -> session + cost_events
//
// Read-only over the sessions, cost_events, and chat_sessions tables. No
// writes, no audit log.

import type { Database } from "bun:sqlite";
import { z } from "zod";

type SessionsApiDeps = {
	db: Database;
};

const MAX_LIST_ROWS = 500;
const MAX_Q_LENGTH = 100;

const DaysSchema = z.union([z.literal("all"), z.coerce.number().int().min(1).max(365)]);

const ListQuerySchema = z.object({
	channel: z.string().max(64).optional(),
	days: DaysSchema.optional(),
	status: z.enum(["active", "expired", "all"]).optional(),
	q: z.string().max(MAX_Q_LENGTH).optional(),
});

type ListQuery = z.infer<typeof ListQuerySchema>;

type SessionRow = {
	session_key: string;
	sdk_session_id: string | null;
	channel_id: string;
	conversation_id: string;
	status: string;
	total_cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	turn_count: number;
	created_at: string;
	last_active_at: string;
	chat_title: string | null;
	chat_message_count: number | null;
	chat_pinned: number | null;
	chat_deleted_at: string | null;
	chat_forked_from_session_id: string | null;
	chat_forked_from_message_seq: number | null;
};

type EnrichedSession = {
	session_key: string;
	sdk_session_id: string | null;
	channel_id: string;
	conversation_id: string;
	status: string;
	total_cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	turn_count: number;
	created_at: string;
	last_active_at: string;
	chat?: {
		title: string | null;
		message_count: number;
		pinned: boolean;
		deleted_at: string | null;
		forked_from_session_id: string | null;
		forked_from_message_seq: number | null;
	};
};

function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
			...((init?.headers as Record<string, string>) ?? {}),
		},
	});
}

function parseListQuery(url: URL): { ok: true; value: ListQuery } | { ok: false; error: string } {
	const raw: Record<string, string> = {};
	const channel = url.searchParams.get("channel");
	const days = url.searchParams.get("days");
	const status = url.searchParams.get("status");
	const q = url.searchParams.get("q");
	if (channel !== null && channel !== "all" && channel.length > 0) raw.channel = channel;
	if (days !== null && days.length > 0) raw.days = days;
	if (status !== null && status.length > 0) raw.status = status;
	if (q !== null) raw.q = q;
	const parsed = ListQuerySchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "query";
		return { ok: false, error: `${path}: ${issue.message}` };
	}
	return { ok: true, value: parsed.data };
}

function buildWhere(filter: ListQuery): { clauses: string[]; params: Array<string | number> } {
	const clauses: string[] = [];
	const params: Array<string | number> = [];
	if (filter.channel && filter.channel !== "all") {
		clauses.push("s.channel_id = ?");
		params.push(filter.channel);
	}
	const days = filter.days ?? 7;
	if (days !== "all") {
		clauses.push("s.last_active_at >= datetime('now', ?)");
		params.push(`-${days} days`);
	}
	const status = filter.status ?? "all";
	if (status !== "all") {
		clauses.push("s.status = ?");
		params.push(status);
	}
	if (filter.q && filter.q.length > 0) {
		clauses.push("(LOWER(s.conversation_id) LIKE ? OR LOWER(s.session_key) LIKE ?)");
		const needle = `%${filter.q.toLowerCase()}%`;
		params.push(needle, needle);
	}
	return { clauses, params };
}

function enrich(row: SessionRow): EnrichedSession {
	const base: EnrichedSession = {
		session_key: row.session_key,
		sdk_session_id: row.sdk_session_id,
		channel_id: row.channel_id,
		conversation_id: row.conversation_id,
		status: row.status,
		total_cost_usd: row.total_cost_usd,
		input_tokens: row.input_tokens,
		output_tokens: row.output_tokens,
		turn_count: row.turn_count,
		created_at: row.created_at,
		last_active_at: row.last_active_at,
	};
	if (row.channel_id === "chat" && row.chat_message_count !== null) {
		base.chat = {
			title: row.chat_title,
			message_count: row.chat_message_count ?? 0,
			pinned: row.chat_pinned === 1,
			deleted_at: row.chat_deleted_at,
			forked_from_session_id: row.chat_forked_from_session_id,
			forked_from_message_seq: row.chat_forked_from_message_seq,
		};
	}
	return base;
}

function listHandler(db: Database, filter: ListQuery): Response {
	const { clauses, params } = buildWhere(filter);
	const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

	const listSql = `
		SELECT
			s.session_key, s.sdk_session_id, s.channel_id, s.conversation_id, s.status,
			s.total_cost_usd, s.input_tokens, s.output_tokens, s.turn_count,
			s.created_at, s.last_active_at,
			cs.title AS chat_title,
			cs.message_count AS chat_message_count,
			cs.pinned AS chat_pinned,
			cs.deleted_at AS chat_deleted_at,
			cs.forked_from_session_id AS chat_forked_from_session_id,
			cs.forked_from_message_seq AS chat_forked_from_message_seq
		FROM sessions s
		LEFT JOIN chat_sessions cs ON s.channel_id = 'chat' AND s.conversation_id = cs.id
		${whereSql}
		ORDER BY s.last_active_at DESC
		LIMIT ${MAX_LIST_ROWS}
	`;
	const rows = db.query(listSql).all(...params) as SessionRow[];

	const totalsSql = `
		SELECT
			COUNT(*) AS total,
			COALESCE(SUM(s.total_cost_usd), 0) AS cost,
			COALESCE(AVG(s.turn_count), 0) AS avg_turns,
			COALESCE(SUM(CASE WHEN s.status = 'active' THEN 1 ELSE 0 END), 0) AS active
		FROM sessions s
		${whereSql}
	`;
	const totalsRow = db.query(totalsSql).get(...params) as {
		total: number;
		cost: number;
		avg_turns: number;
		active: number;
	};

	const byChannelSql = `
		SELECT s.channel_id AS channel_id, COUNT(*) AS count, COALESCE(SUM(s.total_cost_usd), 0) AS cost_usd
		FROM sessions s
		${whereSql}
		GROUP BY s.channel_id
		ORDER BY count DESC
	`;
	const byChannelRows = db.query(byChannelSql).all(...params) as Array<{
		channel_id: string;
		count: number;
		cost_usd: number;
	}>;

	return json({
		sessions: rows.map(enrich),
		summary: {
			total_sessions: totalsRow.total,
			total_cost_usd: totalsRow.cost,
			avg_turns: Number(totalsRow.avg_turns.toFixed(2)),
			active_count: totalsRow.active,
			by_channel: byChannelRows,
		},
		limits: {
			max_list_rows: MAX_LIST_ROWS,
		},
	});
}

function detailHandler(db: Database, sessionKey: string): Response {
	const sessionSql = `
		SELECT
			s.session_key, s.sdk_session_id, s.channel_id, s.conversation_id, s.status,
			s.total_cost_usd, s.input_tokens, s.output_tokens, s.turn_count,
			s.created_at, s.last_active_at,
			cs.title AS chat_title,
			cs.message_count AS chat_message_count,
			cs.pinned AS chat_pinned,
			cs.deleted_at AS chat_deleted_at,
			cs.forked_from_session_id AS chat_forked_from_session_id,
			cs.forked_from_message_seq AS chat_forked_from_message_seq
		FROM sessions s
		LEFT JOIN chat_sessions cs ON s.channel_id = 'chat' AND s.conversation_id = cs.id
		WHERE s.session_key = ?
	`;
	const row = db.query(sessionSql).get(sessionKey) as SessionRow | null;
	if (!row) {
		return json({ error: "Session not found" }, { status: 404 });
	}

	const eventsSql = `
		SELECT created_at, model, input_tokens, output_tokens, cost_usd
		FROM cost_events
		WHERE session_key = ?
		ORDER BY created_at ASC
	`;
	const events = db.query(eventsSql).all(sessionKey) as Array<{
		created_at: string;
		model: string;
		input_tokens: number;
		output_tokens: number;
		cost_usd: number;
	}>;

	return json({
		session: enrich(row),
		cost_events: events,
	});
}

export async function handleSessionsApi(req: Request, url: URL, deps: SessionsApiDeps): Promise<Response | null> {
	const pathname = url.pathname;

	if (pathname === "/ui/api/sessions" && req.method === "GET") {
		const parsed = parseListQuery(url);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
		return listHandler(deps.db, parsed.value);
	}

	const detailMatch = pathname.match(/^\/ui\/api\/sessions\/(.+)$/);
	if (detailMatch && req.method === "GET") {
		let sessionKey: string;
		try {
			sessionKey = decodeURIComponent(detailMatch[1]);
		} catch {
			return json({ error: "Invalid URL-encoded session_key" }, { status: 400 });
		}
		return detailHandler(deps.db, sessionKey);
	}

	if (detailMatch || pathname === "/ui/api/sessions") {
		return json({ error: "Method not allowed" }, { status: 405 });
	}

	return null;
}
