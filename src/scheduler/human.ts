// Tiny cron-to-English helper. Covers the handful of shapes the templates
// and the create form emit; falls through to the raw expression otherwise.
// Deliberately small: no cron-to-English dependency, no lookup tables of
// 1000 patterns. Keep it honest and readable.

import type { Schedule } from "./types.ts";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function humanEvery(intervalMs: number): string {
	const sec = Math.round(intervalMs / 1000);
	if (sec < 60) return `every ${sec}s`;
	const min = Math.round(sec / 60);
	if (min < 60) return `every ${min}m`;
	const hrs = intervalMs / 3_600_000;
	if (Number.isInteger(hrs) && hrs < 48) return `every ${hrs}h`;
	const days = intervalMs / 86_400_000;
	if (Number.isInteger(days)) return `every ${days}d`;
	return `every ${Math.round(min / 60)}h`;
}

function humanCron(expr: string, tz?: string): string {
	const parts = expr.trim().split(/\s+/);
	if (parts.length !== 5) return expr + (tz ? ` ${tz}` : "");
	const [min, hour, dom, month, dow] = parts;

	const tzSuffix = tz ? ` (${tz})` : "";
	const m = Number(min);
	const h = Number(hour);
	const validTime = Number.isFinite(m) && Number.isFinite(h) && m >= 0 && m <= 59 && h >= 0 && h <= 23;

	if (validTime && dom === "*" && month === "*" && dow === "*") {
		return `${formatHhMm(h, m)} every day${tzSuffix}`;
	}
	if (validTime && dom === "*" && month === "*" && dow === "1-5") {
		return `${formatHhMm(h, m)} Mon-Fri${tzSuffix}`;
	}
	if (validTime && dom === "*" && month === "*" && /^[0-6]$/.test(dow)) {
		return `${formatHhMm(h, m)} every ${DAY_NAMES[Number(dow)]}${tzSuffix}`;
	}
	if (validTime && /^\d+$/.test(dom) && month === "*" && dow === "*") {
		return `${formatHhMm(h, m)} on the ${ordinal(Number(dom))} of the month${tzSuffix}`;
	}
	if (/^\*\/\d+$/.test(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") {
		const step = min.slice(2);
		return `every ${step} minutes${tzSuffix}`;
	}
	return expr + tzSuffix;
}

function formatHhMm(h: number, m: number): string {
	const hh = String(h).padStart(2, "0");
	const mm = String(m).padStart(2, "0");
	return `${hh}:${mm}`;
}

function ordinal(n: number): string {
	const s = ["th", "st", "nd", "rd"];
	const v = n % 100;
	return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function humanReadableSchedule(schedule: Schedule): string {
	switch (schedule.kind) {
		case "at":
			return `once at ${schedule.at}`;
		case "every":
			return humanEvery(schedule.intervalMs);
		case "cron":
			return humanCron(schedule.expr, schedule.tz);
	}
}
