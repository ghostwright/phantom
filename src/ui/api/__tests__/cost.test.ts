import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { MIGRATIONS } from "../../../db/schema.ts";
import { handleUiRequest, setDashboardDb, setPublicDir } from "../../serve.ts";
import { createSession, revokeAllSessions } from "../../session.ts";

setPublicDir(resolve(import.meta.dir, "../../../../public"));

let db: Database;
let sessionToken: string;

type CostResponse = {
	range: { from: string | null; to: string; days: number | "all" };
	headline: Record<
		"today" | "yesterday" | "this_week" | "this_month" | "all_time" | "day_delta_pct" | "week_delta_pct",
		number
	>;
	daily: Array<{ day: string; cost_usd: number; by_model: Array<{ model: string; cost_usd: number }> }>;
	by_model: Array<{ model: string; cost_usd: number; pct: number }>;
	by_channel: Array<{ channel_id: string; cost_usd: number; sessions: number; avg_per_session: number }>;
	top_sessions: Array<{ session_key: string; total_cost_usd: number }>;
};

function runMigrations(target: Database): void {
	for (const migration of MIGRATIONS) {
		try {
			target.run(migration);
		} catch {
			// ignore duplicate ALTER errors on repeated migrations
		}
	}
}

function seedSession(
	target: Database,
	row: {
		session_key: string;
		channel_id: string;
		conversation_id: string;
		total_cost_usd?: number;
		turn_count?: number;
		last_active_at?: string;
	},
): void {
	target
		.query(
			`INSERT INTO sessions (session_key, channel_id, conversation_id, total_cost_usd, turn_count, last_active_at)
				VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.session_key,
			row.channel_id,
			row.conversation_id,
			row.total_cost_usd ?? 0,
			row.turn_count ?? 0,
			row.last_active_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
		);
}

function seedCostEvent(
	target: Database,
	row: {
		session_key: string;
		cost_usd: number;
		input_tokens?: number;
		output_tokens?: number;
		model?: string;
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
			row.input_tokens ?? 100,
			row.output_tokens ?? 50,
			row.model ?? "claude-opus-4-7",
			row.created_at ?? new Date().toISOString().replace("T", " ").slice(0, 19),
		);
}

// When h < 24, clamp the result to the same UTC date as "now" so the test is
// stable across the UTC-day boundary. hoursAgo(3) run at 02:53 UTC would
// otherwise resolve to 23:53 the previous day, which SQLite's
// date(created_at) = date('now') would then bucket as yesterday instead of
// today. For h >= 24 (daysAgo callers), the caller intends to cross the
// boundary, so no clamp.
function hoursAgo(h: number): string {
	const now = new Date();
	const requested = new Date(now.getTime() - h * 3600 * 1000);
	if (h < 24 && requested.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
		// Clamp to 5 minutes ago so the event is unambiguously today.
		const clamped = new Date(now.getTime() - 5 * 60 * 1000);
		return clamped.toISOString().replace("T", " ").slice(0, 19);
	}
	return requested.toISOString().replace("T", " ").slice(0, 19);
}

function daysAgo(d: number): string {
	const ts = new Date(Date.now() - d * 24 * 3600 * 1000);
	return ts.toISOString().replace("T", " ").slice(0, 19);
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

describe("cost API", () => {
	test("401 without session cookie", async () => {
		const res = await handleUiRequest(
			new Request("http://localhost/ui/api/cost", { headers: { Accept: "application/json" } }),
		);
		expect(res.status).toBe(401);
	});

	test("POST returns 405", async () => {
		const res = await handleUiRequest(req("/ui/api/cost", { method: "POST", body: "{}" }));
		expect(res.status).toBe(405);
	});

	test("invalid days returns 422", async () => {
		const r1 = await handleUiRequest(req("/ui/api/cost?days=abc"));
		expect(r1.status).toBe(422);
		const r2 = await handleUiRequest(req("/ui/api/cost?days=999"));
		expect(r2.status).toBe(422);
		const r3 = await handleUiRequest(req("/ui/api/cost?days=0"));
		expect(r3.status).toBe(422);
	});

	test("empty DB returns all zeros without NaN or null", async () => {
		const res = await handleUiRequest(req("/ui/api/cost?days=30"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as CostResponse;
		expect(body.headline.today).toBe(0);
		expect(body.headline.yesterday).toBe(0);
		expect(body.headline.this_week).toBe(0);
		expect(body.headline.this_month).toBe(0);
		expect(body.headline.all_time).toBe(0);
		expect(body.headline.day_delta_pct).toBe(0);
		expect(body.headline.week_delta_pct).toBe(0);
		expect(body.daily).toEqual([]);
		expect(body.by_model).toEqual([]);
		expect(body.by_channel).toEqual([]);
		expect(body.top_sessions).toEqual([]);
		const raw = JSON.stringify(body);
		expect(raw.includes("null")).toBe(false);
		expect(raw.includes("NaN")).toBe(false);
	});

	test("headline math: today, yesterday, week, month, all_time", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 1.0, created_at: hoursAgo(1) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 2.0, created_at: hoursAgo(3) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 0.5, created_at: daysAgo(1) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 4.0, created_at: daysAgo(5) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 10.0, created_at: daysAgo(25) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 100.0, created_at: daysAgo(120) });

		const res = await handleUiRequest(req("/ui/api/cost?days=all"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as CostResponse;
		expect(body.headline.today).toBeCloseTo(3.0, 6);
		expect(body.headline.yesterday).toBeCloseTo(0.5, 6);
		expect(body.headline.this_week).toBeCloseTo(7.5, 6);
		expect(body.headline.this_month).toBeCloseTo(17.5, 6);
		expect(body.headline.all_time).toBeCloseTo(117.5, 6);
	});

	test("day_delta_pct is correct and 0 (not NaN) when yesterday is 0", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 5.0, created_at: hoursAgo(1) });

		const res = await handleUiRequest(req("/ui/api/cost?days=all"));
		const body = (await res.json()) as CostResponse;
		expect(body.headline.day_delta_pct).toBe(0);
		expect(Number.isNaN(body.headline.day_delta_pct)).toBe(false);

		db.run("DELETE FROM cost_events");
		seedCostEvent(db, { session_key: "s1", cost_usd: 10.0, created_at: hoursAgo(1) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 5.0, created_at: daysAgo(1) });
		const res2 = await handleUiRequest(req("/ui/api/cost?days=all"));
		const body2 = (await res2.json()) as CostResponse;
		expect(body2.headline.day_delta_pct).toBeCloseTo(100, 1);
	});

	test("week_delta_pct is correct when prior week was populated", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 20.0, created_at: daysAgo(2) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 10.0, created_at: daysAgo(10) });

		const res = await handleUiRequest(req("/ui/api/cost?days=all"));
		const body = (await res.json()) as CostResponse;
		expect(body.headline.week_delta_pct).toBeCloseTo(100, 1);
	});

	test("daily timeseries groups by date with by_model breakdown", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 1.0, model: "claude-opus-4-7", created_at: daysAgo(1) });
		seedCostEvent(db, {
			session_key: "s1",
			cost_usd: 0.5,
			model: "claude-sonnet-4-6",
			created_at: daysAgo(1),
		});
		seedCostEvent(db, { session_key: "s1", cost_usd: 2.0, model: "claude-opus-4-7", created_at: daysAgo(2) });

		const res = await handleUiRequest(req("/ui/api/cost?days=30"));
		const body = (await res.json()) as CostResponse;
		expect(body.daily.length).toBe(2);
		const day2 = body.daily.find((d) => d.day === daysAgo(2).slice(0, 10));
		expect(day2).toBeDefined();
		expect(day2?.cost_usd).toBeCloseTo(2.0, 6);
		expect(day2?.by_model.length).toBe(1);
		expect(day2?.by_model[0].model).toBe("claude-opus-4-7");
		const day1 = body.daily.find((d) => d.day === daysAgo(1).slice(0, 10));
		expect(day1).toBeDefined();
		expect(day1?.cost_usd).toBeCloseTo(1.5, 6);
		expect(day1?.by_model.length).toBe(2);
	});

	test("by_model pct sums to ~1 and orders by cost DESC", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 8.0, model: "claude-opus-4-7" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 2.0, model: "claude-sonnet-4-6" });

		const res = await handleUiRequest(req("/ui/api/cost?days=all"));
		const body = (await res.json()) as CostResponse;
		expect(body.by_model.length).toBe(2);
		expect(body.by_model[0].model).toBe("claude-opus-4-7");
		expect(body.by_model[0].pct).toBeCloseTo(0.8, 3);
		expect(body.by_model[1].pct).toBeCloseTo(0.2, 3);
		const sum = body.by_model.reduce((a, r) => a + r.pct, 0);
		expect(sum).toBeCloseTo(1, 6);
	});

	test("by_channel includes avg_per_session from distinct session count", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedSession(db, { session_key: "s2", channel_id: "slack", conversation_id: "c2" });
		seedSession(db, { session_key: "s3", channel_id: "chat", conversation_id: "c3" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 3.0 });
		seedCostEvent(db, { session_key: "s1", cost_usd: 1.0 });
		seedCostEvent(db, { session_key: "s2", cost_usd: 2.0 });
		seedCostEvent(db, { session_key: "s3", cost_usd: 5.0 });

		const res = await handleUiRequest(req("/ui/api/cost?days=all"));
		const body = (await res.json()) as CostResponse;
		const slack = body.by_channel.find((c) => c.channel_id === "slack");
		expect(slack?.cost_usd).toBeCloseTo(6.0, 6);
		expect(slack?.sessions).toBe(2);
		expect(slack?.avg_per_session).toBeCloseTo(3.0, 6);
		const chat = body.by_channel.find((c) => c.channel_id === "chat");
		expect(chat?.avg_per_session).toBeCloseTo(5.0, 6);
	});

	test("top_sessions limits to 10 and orders by summed cost_events DESC", async () => {
		for (let i = 0; i < 15; i++) {
			seedSession(db, {
				session_key: `k${i}`,
				channel_id: "slack",
				conversation_id: `cv${i}`,
			});
			seedCostEvent(db, { session_key: `k${i}`, cost_usd: (15 - i) * 0.5 });
		}

		const res = await handleUiRequest(req("/ui/api/cost?days=all"));
		const body = (await res.json()) as CostResponse;
		expect(body.top_sessions.length).toBe(10);
		expect(body.top_sessions[0].session_key).toBe("k0");
		expect(body.top_sessions[0].total_cost_usd).toBeCloseTo(7.5, 6);
		for (let i = 1; i < body.top_sessions.length; i++) {
			expect(body.top_sessions[i].total_cost_usd).toBeLessThanOrEqual(body.top_sessions[i - 1].total_cost_usd);
		}
	});

	test("top_sessions ranks by in-window spend, not lifetime", async () => {
		// Session A: $50 lifetime, but only $5 in last 7 days.
		seedSession(db, { session_key: "old-whale", channel_id: "slack", conversation_id: "cw" });
		seedCostEvent(db, { session_key: "old-whale", cost_usd: 45.0, created_at: daysAgo(40) });
		seedCostEvent(db, { session_key: "old-whale", cost_usd: 5.0, created_at: daysAgo(2) });

		// Session B: $10 all from this week.
		seedSession(db, { session_key: "fresh", channel_id: "slack", conversation_id: "cf" });
		seedCostEvent(db, { session_key: "fresh", cost_usd: 10.0, created_at: daysAgo(1) });

		const res = await handleUiRequest(req("/ui/api/cost?days=7"));
		const body = (await res.json()) as CostResponse;
		expect(body.top_sessions[0].session_key).toBe("fresh");
		expect(body.top_sessions[0].total_cost_usd).toBeCloseTo(10.0, 6);
		expect(body.top_sessions[1].session_key).toBe("old-whale");
		expect(body.top_sessions[1].total_cost_usd).toBeCloseTo(5.0, 6);
	});

	test("range param filters daily, by_model, by_channel to window", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 1.0, created_at: daysAgo(3) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 2.0, created_at: daysAgo(10) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 3.0, created_at: daysAgo(40) });

		const res7 = await handleUiRequest(req("/ui/api/cost?days=7"));
		const body7 = (await res7.json()) as CostResponse;
		expect(body7.daily.length).toBe(1);
		expect(body7.by_model[0]?.cost_usd).toBeCloseTo(1.0, 6);

		const res30 = await handleUiRequest(req("/ui/api/cost?days=30"));
		const body30 = (await res30.json()) as CostResponse;
		expect(body30.daily.length).toBe(2);
		expect(body30.by_model[0]?.cost_usd).toBeCloseTo(3.0, 6);

		const resAll = await handleUiRequest(req("/ui/api/cost?days=all"));
		const bodyAll = (await resAll.json()) as CostResponse;
		expect(bodyAll.daily.length).toBe(3);
		expect(bodyAll.by_model[0]?.cost_usd).toBeCloseTo(6.0, 6);
	});

	test("default days is 30 when param omitted", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 1.0, created_at: daysAgo(3) });
		seedCostEvent(db, { session_key: "s1", cost_usd: 5.0, created_at: daysAgo(60) });

		const res = await handleUiRequest(req("/ui/api/cost"));
		const body = (await res.json()) as CostResponse;
		expect(body.range.days).toBe(30);
		expect(body.daily.length).toBe(1);
	});

	test("SQL injection attempt on days is rejected at parse time", async () => {
		seedSession(db, { session_key: "s1", channel_id: "slack", conversation_id: "c1" });
		seedCostEvent(db, { session_key: "s1", cost_usd: 1.0 });
		const before = (db.query("SELECT COUNT(*) as n FROM cost_events").get() as { n: number }).n;
		expect(before).toBe(1);

		const payload = "1; DROP TABLE cost_events; --";
		const res = await handleUiRequest(req(`/ui/api/cost?days=${encodeURIComponent(payload)}`));
		expect(res.status).toBe(422);

		const after = (db.query("SELECT COUNT(*) as n FROM cost_events").get() as { n: number }).n;
		expect(after).toBe(1);
	});
});
