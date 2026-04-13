const DAY_MS = 24 * 60 * 60 * 1000;

export const STALE_EPISODE_RETENTION_DAYS = 30;
export const STALE_EPISODE_MAX_IMPORTANCE = 0.35;
export const STALE_EPISODE_MAX_ACCESS_COUNT = 1;
export const EXPIRED_FACT_RETENTION_DAYS = 30;
export const RETENTION_BATCH_LIMIT = 50;

export function buildStaleEpisodeFilter(userId: string, referenceTimeMs: number): Record<string, unknown> {
	return {
		must: [
			{ key: "user_id", match: { value: userId } },
			{ key: "ended_at", range: { lte: referenceTimeMs - STALE_EPISODE_RETENTION_DAYS * DAY_MS } },
			{ key: "importance", range: { lte: STALE_EPISODE_MAX_IMPORTANCE } },
			{ key: "access_count", range: { lte: STALE_EPISODE_MAX_ACCESS_COUNT } },
		],
	};
}

export function buildExpiredFactFilter(referenceTimeMs: number): Record<string, unknown> {
	return {
		must: [{ key: "valid_until", range: { lte: referenceTimeMs - EXPIRED_FACT_RETENTION_DAYS * DAY_MS } }],
	};
}
