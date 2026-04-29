import { describe, expect, test } from "bun:test";
import { calculateEpisodeRecallScore, shouldIncludeEpisodeInContext } from "../ranking.ts";
import type { Episode } from "../types.ts";

function makeEpisode(overrides?: Partial<Episode>): Episode {
	return {
		id: "ep-1",
		type: "task",
		summary: "Memory summary",
		detail: "Memory detail",
		parent_id: null,
		session_id: "session-1",
		user_id: "user-1",
		tools_used: [],
		files_touched: [],
		outcome: "success",
		outcome_detail: "Completed successfully",
		lessons: [],
		started_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
		ended_at: new Date().toISOString(),
		duration_seconds: 60,
		importance: 0.6,
		access_count: 0,
		last_accessed_at: new Date().toISOString(),
		decay_rate: 1,
		...overrides,
	};
}

describe("memory ranking", () => {
	test("metadata strategy rewards reinforced memories", () => {
		const staleWeak = calculateEpisodeRecallScore(
			0.82,
			{
				importance: 0.3,
				accessCount: 0,
				startedAt: Date.now() - 45 * 24 * 3600 * 1000,
				lastAccessedAt: new Date(Date.now() - 45 * 24 * 3600 * 1000).toISOString(),
				decayRate: 1,
			},
			"metadata",
		);

		const durableRepeat = calculateEpisodeRecallScore(
			0.7,
			{
				importance: 0.8,
				accessCount: 6,
				startedAt: Date.now() - 45 * 24 * 3600 * 1000,
				lastAccessedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString(),
				decayRate: 1,
			},
			"metadata",
		);

		expect(durableRepeat).toBeGreaterThan(staleWeak);
	});

	test("context filtering drops stale low-signal memories", () => {
		const staleWeak = makeEpisode({
			importance: 0.2,
			access_count: 0,
			started_at: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
			last_accessed_at: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
		});

		const durableRepeat = makeEpisode({
			id: "ep-2",
			importance: 0.85,
			access_count: 5,
			started_at: new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString(),
			last_accessed_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
		});

		expect(shouldIncludeEpisodeInContext(staleWeak)).toBe(false);
		expect(shouldIncludeEpisodeInContext(durableRepeat)).toBe(true);
	});

	test("invalid timestamps degrade gracefully", () => {
		const score = calculateEpisodeRecallScore(
			0.5,
			{
				importance: 0.6,
				accessCount: 2,
				startedAt: "not-a-date",
				lastAccessedAt: "still-not-a-date",
				decayRate: 1,
			},
			"metadata",
		);

		expect(score).toBeFinite();
	});
});
