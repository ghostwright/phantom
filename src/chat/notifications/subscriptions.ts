// Push subscription CRUD on chat_push_subscriptions table.
// Upserts on endpoint (the unique identifier per browser install).

import type { Database } from "bun:sqlite";

export type PushSubscriptionRow = {
	id: number;
	endpoint: string;
	p256dh: string;
	auth: string;
	user_agent: string | null;
	disabled: number;
	consecutive_errors: number;
	last_success_at: string | null;
	last_error_at: string | null;
	created_at: string;
	updated_at: string;
};

export function isValidPushEndpoint(endpoint: string): boolean {
	try {
		const url = new URL(endpoint);
		return url.protocol === "https:";
	} catch {
		return false;
	}
}

export function subscribe(
	db: Database,
	sub: { endpoint: string; p256dh: string; auth: string; userAgent?: string },
): void {
	db.run(
		`INSERT INTO chat_push_subscriptions (endpoint, p256dh, auth, user_agent, consecutive_errors, disabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 0, 0, datetime('now'), datetime('now'))
		 ON CONFLICT(endpoint) DO UPDATE SET
		   p256dh = excluded.p256dh,
		   auth = excluded.auth,
		   user_agent = excluded.user_agent,
		   consecutive_errors = 0,
		   disabled = 0,
		   updated_at = datetime('now')`,
		[sub.endpoint, sub.p256dh, sub.auth, sub.userAgent ?? null],
	);
}

export function unsubscribe(db: Database, endpoint: string): void {
	db.run("DELETE FROM chat_push_subscriptions WHERE endpoint = ?", [endpoint]);
}

export function getActiveSubscriptions(db: Database): PushSubscriptionRow[] {
	return db.query("SELECT * FROM chat_push_subscriptions WHERE disabled = 0").all() as PushSubscriptionRow[];
}

export function recordSuccess(db: Database, endpoint: string): void {
	db.run(
		"UPDATE chat_push_subscriptions SET last_success_at = datetime('now'), consecutive_errors = 0, updated_at = datetime('now') WHERE endpoint = ?",
		[endpoint],
	);
}

export function recordError(db: Database, endpoint: string): void {
	db.run(
		`UPDATE chat_push_subscriptions SET
		   consecutive_errors = consecutive_errors + 1,
		   last_error_at = datetime('now'),
		   updated_at = datetime('now'),
		   disabled = CASE WHEN consecutive_errors + 1 >= 10 THEN 1 ELSE disabled END
		 WHERE endpoint = ?`,
		[endpoint],
	);
}

export function removeGone(db: Database, endpoint: string): void {
	db.run("DELETE FROM chat_push_subscriptions WHERE endpoint = ?", [endpoint]);
}

export function getSubscriptionCount(db: Database): number {
	const row = db.query("SELECT COUNT(*) as count FROM chat_push_subscriptions WHERE disabled = 0").get() as {
		count: number;
	};
	return row.count;
}
