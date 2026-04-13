import { Cron } from "croner";
import type { Schedule } from "./types.ts";

/**
 * Compute the next run time for a schedule.
 * Returns null if the schedule has no future run (e.g., one-shot in the past).
 */
export function computeNextRunAt(schedule: Schedule, afterMs: number = Date.now()): Date | null {
	switch (schedule.kind) {
		case "at": {
			const atMs = new Date(schedule.at).getTime();
			if (Number.isNaN(atMs)) return null;
			return atMs > afterMs ? new Date(atMs) : null;
		}
		case "every": {
			return new Date(afterMs + schedule.intervalMs);
		}
		case "cron": {
			const tz = schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
			// Pin to standard 5-field cron (M3). Croner's mode:"5-part" rejects
			// 6/7 part expressions; we also reject nicknames like @daily because
			// the tool description promises 5-field syntax and nicknames invite
			// ambiguous scheduling.
			if (schedule.expr.trim().startsWith("@")) return null;
			try {
				const cron = new Cron(schedule.expr, { timezone: tz, mode: "5-part" });
				return cron.nextRun(new Date(afterMs));
			} catch {
				return null;
			}
		}
	}
}

/**
 * Parse the schedule_value JSON string stored in SQLite back into a Schedule object.
 */
export function parseScheduleValue(kind: string, value: string): Schedule {
	const parsed = JSON.parse(value);
	switch (kind) {
		case "at":
			return { kind: "at", at: parsed.at };
		case "every":
			return { kind: "every", intervalMs: parsed.intervalMs };
		case "cron":
			return { kind: "cron", expr: parsed.expr, ...(parsed.tz ? { tz: parsed.tz } : {}) };
		default:
			throw new Error(`Unknown schedule kind: ${kind}`);
	}
}

/**
 * Serialize a Schedule to a JSON string for SQLite storage.
 */
export function serializeScheduleValue(schedule: Schedule): string {
	switch (schedule.kind) {
		case "at":
			return JSON.stringify({ at: schedule.at });
		case "every":
			return JSON.stringify({ intervalMs: schedule.intervalMs });
		case "cron":
			return JSON.stringify({ expr: schedule.expr, ...(schedule.tz ? { tz: schedule.tz } : {}) });
	}
}

/**
 * Validate a schedule at creation time. Returns a descriptive error string
 * when the schedule cannot produce a future fire time. Returns null when the
 * schedule is valid and computeNextRunAt will succeed. See C1 in the audit.
 */
export function validateSchedule(schedule: Schedule): string | null {
	switch (schedule.kind) {
		case "at": {
			const atMs = new Date(schedule.at).getTime();
			if (Number.isNaN(atMs)) {
				return `invalid 'at' timestamp: ${schedule.at} (use ISO 8601 with an explicit offset, e.g. 2026-03-26T09:00:00-07:00)`;
			}
			if (atMs <= Date.now()) {
				return `'at' timestamp is in the past: ${schedule.at}`;
			}
			return null;
		}
		case "every": {
			if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) {
				return `'every' intervalMs must be positive, got ${schedule.intervalMs}`;
			}
			return null;
		}
		case "cron": {
			const tz = schedule.tz || Intl.DateTimeFormat().resolvedOptions().timeZone;
			if (schedule.expr.trim().startsWith("@")) {
				return `cron nicknames like '${schedule.expr}' are not supported; use explicit 5-field syntax (minute hour day month day-of-week)`;
			}
			try {
				const cron = new Cron(schedule.expr, { timezone: tz, mode: "5-part" });
				const next = cron.nextRun(new Date());
				if (!next) {
					return `cron expression has no future fire: ${schedule.expr}`;
				}
				return null;
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				// Croner's TypeError about timezone is the common case for bad tz.
				if (/timezone/i.test(msg)) {
					return `invalid timezone '${tz}': ${msg}`;
				}
				return `invalid cron expression '${schedule.expr}': ${msg} (use 5-field cron: minute hour day month day-of-week)`;
			}
		}
	}
}

/** Exponential backoff delays for consecutive errors */
const BACKOFF_DELAYS_MS = [
	30_000, // 1st error: 30s
	60_000, // 2nd: 1 min
	300_000, // 3rd: 5 min
	900_000, // 4th: 15 min
	3_600_000, // 5th+: 60 min
];

/**
 * Compute the next run time with exponential backoff for error recovery.
 */
export function computeBackoffNextRun(consecutiveErrors: number): Date {
	const index = Math.min(consecutiveErrors - 1, BACKOFF_DELAYS_MS.length - 1);
	const delay = BACKOFF_DELAYS_MS[Math.max(0, index)];
	return new Date(Date.now() + delay);
}
