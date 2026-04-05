import type { Episode, RecallOptions } from "./types.ts";

type EpisodeRankingMetadata = {
	importance?: number;
	accessCount?: number;
	startedAt?: number | string;
	lastAccessedAt?: string;
	decayRate?: number;
};

const MIN_DECAY_RATE = 0.25;
const MAX_DECAY_RATE = 3;
const RECENCY_HALF_LIFE_HOURS = 24 * 14;
const ACCESS_HALF_LIFE_HOURS = 24 * 21;
const ACCESS_SATURATION = Math.log1p(8);
const CONTEXT_SCORE_THRESHOLD = 0.25;

export function calculateEpisodeRecallScore(
	searchScore: number,
	metadata: EpisodeRankingMetadata,
	strategy: RecallOptions["strategy"] = "recency",
): number {
	const signals = getEpisodeSignals(metadata);

	switch (strategy) {
		case "similarity":
			return weightedAverage(searchScore, signals.durability, signals.recency, 0.55, 0.3, 0.15);
		case "temporal":
			return weightedAverage(searchScore, signals.durability, signals.recency, 0.25, 0.2, 0.55);
		case "metadata":
			return weightedAverage(searchScore, signals.durability, signals.recency, 0.2, 0.6, 0.2);
		default:
			return weightedAverage(searchScore, signals.durability, signals.recency, 0.3, 0.3, 0.4);
	}
}

export function calculateEpisodeContextScore(episode: Episode): number {
	const signals = getEpisodeSignals({
		importance: episode.importance,
		accessCount: episode.access_count,
		startedAt: episode.started_at,
		lastAccessedAt: episode.last_accessed_at,
		decayRate: episode.decay_rate,
	});

	return signals.durability * 0.6 + signals.recency * 0.4;
}

export function shouldIncludeEpisodeInContext(episode: Episode): boolean {
	if (episode.importance >= 0.85) return true;
	if (episode.access_count >= 3) return true;

	return calculateEpisodeContextScore(episode) >= CONTEXT_SCORE_THRESHOLD;
}

function getEpisodeSignals(metadata: EpisodeRankingMetadata): { durability: number; recency: number } {
	const importance = clamp(metadata.importance ?? 0.5, 0, 1);
	const accessCount = Math.max(0, metadata.accessCount ?? 0);
	const decayRate = clamp(metadata.decayRate ?? 1, MIN_DECAY_RATE, MAX_DECAY_RATE);
	const ageHours = hoursSince(metadata.startedAt);
	const lastAccessHours = metadata.lastAccessedAt ? hoursSince(metadata.lastAccessedAt) : Number.POSITIVE_INFINITY;

	const recency = exponentialDecay(ageHours, RECENCY_HALF_LIFE_HOURS, decayRate);
	const accessFreshness =
		lastAccessHours === Number.POSITIVE_INFINITY
			? 0
			: exponentialDecay(lastAccessHours, ACCESS_HALF_LIFE_HOURS, decayRate);
	const accessReinforcement = clamp(Math.log1p(accessCount) / ACCESS_SATURATION, 0, 1);
	const durability = weightedAverage(importance, accessReinforcement, accessFreshness, 0.55, 0.3, 0.15);

	return { durability, recency };
}

function weightedAverage(a: number, b: number, c: number, aWeight: number, bWeight: number, cWeight: number): number {
	return a * aWeight + b * bWeight + c * cWeight;
}

function exponentialDecay(ageHours: number, halfLifeHours: number, decayRate: number): number {
	if (!Number.isFinite(ageHours) || ageHours < 0) return 1;
	return Math.exp(-((ageHours / halfLifeHours) * decayRate));
}

function hoursSince(value?: number | string): number {
	if (value == null) return Number.POSITIVE_INFINITY;

	const timestamp = typeof value === "number" ? value : Date.parse(value);

	if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;

	return Math.max(0, (Date.now() - timestamp) / (1000 * 60 * 60));
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}
