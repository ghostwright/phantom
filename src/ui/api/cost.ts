// UI API route for the Cost dashboard tab. One combined endpoint so the
// client does a single fetch.
//
//   GET /ui/api/cost?days=<n|all>
//
// Returns headline totals, a daily stacked-by-model timeseries, by-model
// and by-channel breakdowns, and the 10 most expensive sessions. Read-only
// over cost_events + sessions, cookie-auth gated by the dispatcher.

import type { Database } from "bun:sqlite";
import { z } from "zod";
import { getByChannel, getByModel, getCostHeadline, getDailyCost, getTopSessions } from "../../agent/cost-queries.ts";

type CostApiDeps = {
	db: Database;
};

const TOP_SESSIONS_LIMIT = 10;

const DaysSchema = z.union([z.literal("all"), z.coerce.number().int().min(1).max(365)]);

const QuerySchema = z.object({
	days: DaysSchema.optional(),
});

type CostQuery = z.infer<typeof QuerySchema>;

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

function parseQuery(url: URL): { ok: true; value: CostQuery } | { ok: false; error: string } {
	const raw: Record<string, string> = {};
	const days = url.searchParams.get("days");
	if (days !== null && days.length > 0) raw.days = days;
	const parsed = QuerySchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const path = issue.path.length > 0 ? issue.path.join(".") : "query";
		return { ok: false, error: `${path}: ${issue.message}` };
	}
	return { ok: true, value: parsed.data };
}

function handleGet(db: Database, filter: CostQuery): Response {
	const daysVal = filter.days ?? 30;
	const days: number | null = daysVal === "all" ? null : daysVal;

	const headline = getCostHeadline(db);
	const daily = getDailyCost(db, days);
	const by_model = getByModel(db, days);
	const by_channel = getByChannel(db, days);
	const top_sessions = getTopSessions(db, TOP_SESSIONS_LIMIT, days);

	const now = new Date();
	const from = days === null ? null : new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
	const to = now.toISOString().slice(0, 10);

	return json({
		range: { from, to, days: days === null ? "all" : days },
		headline,
		daily,
		by_model,
		by_channel,
		top_sessions,
		limits: { top_sessions: TOP_SESSIONS_LIMIT },
	});
}

export async function handleCostApi(req: Request, url: URL, deps: CostApiDeps): Promise<Response | null> {
	if (url.pathname !== "/ui/api/cost") return null;

	if (req.method === "GET") {
		const parsed = parseQuery(url);
		if (!parsed.ok) return json({ error: parsed.error }, { status: 422 });
		return handleGet(deps.db, parsed.value);
	}

	return json({ error: "Method not allowed" }, { status: 405 });
}
