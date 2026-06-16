import { describe, expect, test } from "bun:test";
import { humanReadableSchedule } from "../human.ts";
import type { Schedule } from "../types.ts";

describe("humanReadableSchedule", () => {
	describe("at schedules", () => {
		test("formats a one-time schedule", () => {
			const schedule: Schedule = { kind: "at", at: "2026-03-26T09:00:00-07:00" };
			expect(humanReadableSchedule(schedule)).toBe("once at 2026-03-26T09:00:00-07:00");
		});
	});

	describe("every schedules", () => {
		test("formats seconds interval", () => {
			const schedule: Schedule = { kind: "every", intervalMs: 30_000 };
			expect(humanReadableSchedule(schedule)).toBe("every 30s");
		});

		test("formats minutes interval", () => {
			const schedule: Schedule = { kind: "every", intervalMs: 300_000 };
			expect(humanReadableSchedule(schedule)).toBe("every 5m");
		});

		test("formats hours interval", () => {
			const schedule: Schedule = { kind: "every", intervalMs: 7_200_000 };
			expect(humanReadableSchedule(schedule)).toBe("every 2h");
		});

		test("formats days interval", () => {
			const schedule: Schedule = { kind: "every", intervalMs: 86_400_000 };
			expect(humanReadableSchedule(schedule)).toBe("every 24h");
		});

		test("formats multi-day interval", () => {
			const schedule: Schedule = { kind: "every", intervalMs: 259_200_000 };
			expect(humanReadableSchedule(schedule)).toBe("every 3d");
		});

		test("falls back to hours for non-integer hours below 48h", () => {
			const schedule: Schedule = { kind: "every", intervalMs: 5_400_000 }; // 1.5h
			expect(humanReadableSchedule(schedule)).toBe("every 2h");
		});
	});

	describe("cron schedules", () => {
		test("formats daily at specific time", () => {
			const schedule: Schedule = { kind: "cron", expr: "30 9 * * *" };
			expect(humanReadableSchedule(schedule)).toBe("09:30 every day");
		});

		test("formats daily with timezone", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 8 * * *", tz: "America/New_York" };
			expect(humanReadableSchedule(schedule)).toBe("08:00 every day (America/New_York)");
		});

		test("formats weekday schedule (Mon-Fri)", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 9 * * 1-5" };
			expect(humanReadableSchedule(schedule)).toBe("09:00 Mon-Fri");
		});

		test("formats specific day of week", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 10 * * 3" };
			expect(humanReadableSchedule(schedule)).toBe("10:00 every Wed");
		});

		test("formats Sunday schedule", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 12 * * 0" };
			expect(humanReadableSchedule(schedule)).toBe("12:00 every Sun");
		});

		test("formats Saturday schedule", () => {
			const schedule: Schedule = { kind: "cron", expr: "30 18 * * 6" };
			expect(humanReadableSchedule(schedule)).toBe("18:30 every Sat");
		});

		test("formats monthly (day-of-month)", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 9 15 * *" };
			expect(humanReadableSchedule(schedule)).toBe("09:00 on the 15th of the month");
		});

		test("formats monthly 1st", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 8 1 * *" };
			expect(humanReadableSchedule(schedule)).toBe("08:00 on the 1st of the month");
		});

		test("formats monthly 2nd", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 8 2 * *" };
			expect(humanReadableSchedule(schedule)).toBe("08:00 on the 2nd of the month");
		});

		test("formats monthly 3rd", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 8 3 * *" };
			expect(humanReadableSchedule(schedule)).toBe("08:00 on the 3rd of the month");
		});

		test("formats every-N-minutes pattern", () => {
			const schedule: Schedule = { kind: "cron", expr: "*/15 * * * *" };
			expect(humanReadableSchedule(schedule)).toBe("every 15 minutes");
		});

		test("formats every-N-minutes with timezone", () => {
			const schedule: Schedule = { kind: "cron", expr: "*/5 * * * *", tz: "UTC" };
			expect(humanReadableSchedule(schedule)).toBe("every 5 minutes (UTC)");
		});

		test("falls through to raw expression for complex cron", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 9 1,15 * *" };
			expect(humanReadableSchedule(schedule)).toBe("0 9 1,15 * *");
		});

		test("falls through with timezone suffix for unrecognized cron", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 9 1,15 * *", tz: "Europe/London" };
			expect(humanReadableSchedule(schedule)).toBe("0 9 1,15 * * (Europe/London)");
		});

		test("falls through for non-5-field expression", () => {
			const schedule: Schedule = { kind: "cron", expr: "0 9 * *" };
			expect(humanReadableSchedule(schedule)).toBe("0 9 * *");
		});

		test("zero-pads single digit hours and minutes", () => {
			const schedule: Schedule = { kind: "cron", expr: "5 7 * * *" };
			expect(humanReadableSchedule(schedule)).toBe("07:05 every day");
		});
	});
});
