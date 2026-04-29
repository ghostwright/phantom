// Cost aggregation queries shared between the MCP cost resource, the
// universal_metrics_read tool, and the dashboard cost API. All SQL uses
// COALESCE(SUM(...), 0) so empty result sets return 0 rather than NULL.

import type { Database } from "bun:sqlite";

export type CostForPeriod = { total: number; events: number };

export type CostHeadline = {
	today: number;
	yesterday: number;
	this_week: number;
	this_month: number;
	all_time: number;
	day_delta_pct: number;
	week_delta_pct: number;
};

export type DailyCostRow = {
	day: string;
	cost_usd: number;
	input_tokens: number;
	output_tokens: number;
	by_model: Array<{ model: string; cost_usd: number }>;
};

export type ByModelRow = {
	model: string;
	cost_usd: number;
	pct: number;
	input_tokens: number;
	output_tokens: number;
	events: number;
};

export type ByChannelRow = {
	channel_id: string;
	cost_usd: number;
	sessions: number;
	avg_per_session: number;
	input_tokens: number;
	output_tokens: number;
};

export type TopSessionRow = {
	session_key: string;
	channel_id: string;
	conversation_id: string;
	total_cost_usd: number;
	turn_count: number;
	last_active_at: string;
};

// Percent change from `prior` to `now`, or 0 when prior is 0 (avoids NaN).
function deltaPct(now: number, prior: number): number {
	return prior === 0 ? 0 : ((now - prior) / prior) * 100;
}

// Helper: run a single-row `SELECT COALESCE(SUM(cost_usd), 0) AS total`
// scoped by an inlined date expression. `dateExpr` is a trusted constant,
// never interpolated from user input.
function sumCost(db: Database, dateExpr: string): number {
	const row = db.query(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_events WHERE ${dateExpr}`).get() as {
		total: number;
	};
	return row.total;
}

// Shared by MCP cost resource and universal metrics tool. `dateFilter` is
// an inlined SQLite date expression (e.g. "date('now', '-7 days')").
export function getCostForPeriod(db: Database, dateFilter: string): CostForPeriod {
	const row = db
		.query(
			`SELECT COALESCE(SUM(cost_usd), 0) AS total, COUNT(*) AS events
			 FROM cost_events WHERE created_at >= ${dateFilter}`,
		)
		.get() as { total: number; events: number };
	return row;
}

export function getCostHeadline(db: Database): CostHeadline {
	const today = sumCost(db, "date(created_at) = date('now')");
	const yesterday = sumCost(db, "date(created_at) = date('now', '-1 day')");
	const thisWeek = sumCost(db, "created_at >= datetime('now', '-7 days')");
	const priorWeek = sumCost(
		db,
		"created_at >= datetime('now', '-14 days') AND created_at < datetime('now', '-7 days')",
	);
	const thisMonth = sumCost(db, "created_at >= datetime('now', '-30 days')");
	const allTime = (db.query("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_events").get() as { total: number })
		.total;

	return {
		today,
		yesterday,
		this_week: thisWeek,
		this_month: thisMonth,
		all_time: allTime,
		day_delta_pct: deltaPct(today, yesterday),
		week_delta_pct: deltaPct(thisWeek, priorWeek),
	};
}

// `days` is null for all-time, otherwise clamped by the caller. Returns
// only days that have events; the chart skips missing days on its x-axis.
export function getDailyCost(db: Database, days: number | null): DailyCostRow[] {
	const where = days === null ? "" : "WHERE created_at >= datetime('now', ?)";
	const params: string[] = days === null ? [] : [`-${days} days`];

	const dayRows = db
		.query(
			`SELECT date(created_at) AS day,
			        COALESCE(SUM(cost_usd), 0) AS cost_usd,
			        COALESCE(SUM(input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(output_tokens), 0) AS output_tokens
			 FROM cost_events ${where} GROUP BY day ORDER BY day ASC`,
		)
		.all(...params) as Array<{ day: string; cost_usd: number; input_tokens: number; output_tokens: number }>;

	const modelRows = db
		.query(
			`SELECT date(created_at) AS day, model, COALESCE(SUM(cost_usd), 0) AS cost_usd
			 FROM cost_events ${where} GROUP BY day, model ORDER BY day ASC, cost_usd DESC`,
		)
		.all(...params) as Array<{ day: string; model: string; cost_usd: number }>;

	const byDay = new Map<string, Array<{ model: string; cost_usd: number }>>();
	for (const mr of modelRows) {
		const list = byDay.get(mr.day) ?? [];
		list.push({ model: mr.model, cost_usd: mr.cost_usd });
		byDay.set(mr.day, list);
	}

	return dayRows.map((r) => ({ ...r, by_model: byDay.get(r.day) ?? [] }));
}

export function getByModel(db: Database, days: number | null): ByModelRow[] {
	const where = days === null ? "" : "WHERE created_at >= datetime('now', ?)";
	const params: string[] = days === null ? [] : [`-${days} days`];

	const rows = db
		.query(
			`SELECT model, COALESCE(SUM(cost_usd), 0) AS cost_usd,
			        COALESCE(SUM(input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(output_tokens), 0) AS output_tokens, COUNT(*) AS events
			 FROM cost_events ${where} GROUP BY model ORDER BY cost_usd DESC`,
		)
		.all(...params) as Array<Omit<ByModelRow, "pct">>;

	const total = rows.reduce((acc, r) => acc + r.cost_usd, 0);
	return rows.map((r) => ({ ...r, pct: total > 0 ? r.cost_usd / total : 0 }));
}

export function getByChannel(db: Database, days: number | null): ByChannelRow[] {
	const where = days === null ? "" : "WHERE ce.created_at >= datetime('now', ?)";
	const params: string[] = days === null ? [] : [`-${days} days`];

	const rows = db
		.query(
			`SELECT s.channel_id AS channel_id, COALESCE(SUM(ce.cost_usd), 0) AS cost_usd,
			        COUNT(DISTINCT ce.session_key) AS sessions,
			        COALESCE(SUM(ce.input_tokens), 0) AS input_tokens,
			        COALESCE(SUM(ce.output_tokens), 0) AS output_tokens
			 FROM cost_events ce JOIN sessions s ON ce.session_key = s.session_key
			 ${where} GROUP BY s.channel_id ORDER BY cost_usd DESC`,
		)
		.all(...params) as Array<Omit<ByChannelRow, "avg_per_session">>;

	return rows.map((r) => ({ ...r, avg_per_session: r.sessions > 0 ? r.cost_usd / r.sessions : 0 }));
}

export function getTopSessions(db: Database, limit: number, days: number | null): TopSessionRow[] {
	// Sum cost_events within the chosen window so the table reflects spend in
	// the active range, not lifetime totals. Sessions with large historical
	// cost but no recent activity correctly drop out of short-window views.
	const where = days === null ? "" : "WHERE ce.created_at >= datetime('now', ?)";
	const params: Array<string | number> = days === null ? [] : [`-${days} days`];

	return db
		.query(
			`SELECT s.session_key, s.channel_id, s.conversation_id,
			        COALESCE(SUM(ce.cost_usd), 0) AS total_cost_usd,
			        s.turn_count, s.last_active_at
			 FROM cost_events ce
			 JOIN sessions s ON ce.session_key = s.session_key
			 ${where}
			 GROUP BY s.session_key, s.channel_id, s.conversation_id, s.turn_count, s.last_active_at
			 ORDER BY total_cost_usd DESC, s.last_active_at DESC
			 LIMIT ?`,
		)
		.all(...params, limit) as TopSessionRow[];
}
