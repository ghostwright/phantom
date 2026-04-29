import type { MemoryConfig } from "../config/types.ts";
import { type EmbeddingClient, textToSparseVector } from "./embeddings.ts";
import type { QdrantClient } from "./qdrant-client.ts";
import { calculateEpisodeRecallScore } from "./ranking.ts";
import type { Episode, QdrantSearchResult, RecallOptions } from "./types.ts";

const COLLECTION_SCHEMA = {
	vectors: {
		summary: { size: 768, distance: "Cosine" },
		detail: { size: 768, distance: "Cosine" },
	},
	sparse_vectors: {
		text_bm25: {},
	},
} as const;

const PAYLOAD_INDEXES: { field: string; type: "keyword" | "integer" | "float" }[] = [
	{ field: "type", type: "keyword" },
	{ field: "outcome", type: "keyword" },
	{ field: "session_id", type: "keyword" },
	{ field: "user_id", type: "keyword" },
	{ field: "started_at", type: "integer" },
	{ field: "ended_at", type: "integer" },
	{ field: "importance", type: "float" },
	{ field: "access_count", type: "integer" },
	{ field: "tools_used", type: "keyword" },
	{ field: "files_touched", type: "keyword" },
	{ field: "parent_id", type: "keyword" },
];

export class EpisodicStore {
	private qdrant: QdrantClient;
	private embedder: EmbeddingClient;
	private collectionName: string;

	constructor(qdrant: QdrantClient, embedder: EmbeddingClient, config: MemoryConfig) {
		this.qdrant = qdrant;
		this.embedder = embedder;
		this.collectionName = config.collections.episodes;
	}

	async initialize(): Promise<void> {
		await this.qdrant.createCollection(this.collectionName, {
			vectors: { ...COLLECTION_SCHEMA.vectors },
			sparse_vectors: { ...COLLECTION_SCHEMA.sparse_vectors },
		});

		for (const index of PAYLOAD_INDEXES) {
			await this.qdrant.createPayloadIndex(this.collectionName, index.field, index.type);
		}
	}

	async store(episode: Episode): Promise<string> {
		const [summaryVec, detailVec] = await this.embedder.embedBatch([episode.summary, episode.detail]);

		const combinedText = `${episode.summary} ${episode.detail} ${episode.lessons.join(" ")}`;
		const sparse = textToSparseVector(combinedText);

		await this.qdrant.upsert(this.collectionName, [
			{
				id: episode.id,
				vector: {
					summary: summaryVec,
					detail: detailVec,
					text_bm25: sparse,
				},
				payload: {
					type: episode.type,
					summary: episode.summary,
					detail: episode.detail,
					parent_id: episode.parent_id,
					session_id: episode.session_id,
					user_id: episode.user_id,
					tools_used: episode.tools_used,
					files_touched: episode.files_touched,
					outcome: episode.outcome,
					outcome_detail: episode.outcome_detail,
					lessons: episode.lessons,
					started_at: new Date(episode.started_at).getTime(),
					ended_at: new Date(episode.ended_at).getTime(),
					duration_seconds: episode.duration_seconds,
					importance: episode.importance,
					access_count: episode.access_count,
					last_accessed_at: episode.last_accessed_at,
					decay_rate: episode.decay_rate,
				},
			},
		]);

		return episode.id;
	}

	async recall(query: string, options?: RecallOptions): Promise<Episode[]> {
		const limit = options?.limit ?? 10;
		const strategy = options?.strategy ?? "recency";

		const queryVec = await this.embedder.embed(query);
		const sparse = textToSparseVector(query);

		const filter = this.buildFilter(options);

		const results = await this.qdrant.search(this.collectionName, {
			denseVector: queryVec,
			denseVectorName: "summary",
			sparseVector: sparse,
			sparseVectorName: "text_bm25",
			filter,
			limit: limit * 2,
			withPayload: true,
		});

		const scored = this.applyStrategy(results, strategy);
		const topResults = scored.slice(0, limit);

		// Update access counts in background
		this.updateAccessCounts(topResults.map((r) => r.id)).catch(() => {});

		return topResults.map((r) => this.payloadToEpisode(r));
	}

	async updateAccessCount(id: string): Promise<void> {
		await this.qdrant.updatePayload(this.collectionName, id, {
			access_count: { $inc: 1 },
			last_accessed_at: new Date().toISOString(),
		});
	}

	private async updateAccessCounts(ids: string[]): Promise<void> {
		for (const id of ids) {
			try {
				await this.qdrant.updatePayload(this.collectionName, id, {
					access_count: { $inc: 1 },
					last_accessed_at: new Date().toISOString(),
				});
			} catch {
				// Non-critical, best-effort
			}
		}
	}

	private buildFilter(options?: RecallOptions): Record<string, unknown> | undefined {
		if (!options) return undefined;

		const must: Record<string, unknown>[] = [];

		if (options.timeRange) {
			must.push({
				key: "started_at",
				range: {
					gte: options.timeRange.from.getTime(),
					lte: options.timeRange.to.getTime(),
				},
			});
		}

		if (options.filters) {
			for (const [key, value] of Object.entries(options.filters)) {
				if (Array.isArray(value)) {
					must.push({ key, match: { any: value } });
				} else {
					must.push({ key, match: { value } });
				}
			}
		}

		if (must.length === 0) return undefined;
		return { must };
	}

	private applyStrategy(results: QdrantSearchResult[], strategy: RecallOptions["strategy"]): QdrantSearchResult[] {
		return results
			.map((r) => {
				return {
					...r,
					score: calculateEpisodeRecallScore(
						r.score,
						{
							importance: (r.payload.importance as number) ?? 0.5,
							accessCount: (r.payload.access_count as number) ?? 0,
							startedAt: (r.payload.started_at as number) ?? 0,
							lastAccessedAt: (r.payload.last_accessed_at as string | undefined) ?? undefined,
							decayRate: (r.payload.decay_rate as number) ?? 1,
						},
						strategy,
					),
				};
			})
			.sort((a, b) => b.score - a.score);
	}

	async scroll(opts: {
		limit: number;
		offset?: string | number;
	}): Promise<{ items: Episode[]; nextOffset: string | number | null }> {
		const { points, nextOffset } = await this.qdrant.scroll(this.collectionName, {
			limit: opts.limit,
			offset: opts.offset,
			orderBy: { key: "started_at", direction: "desc" },
			withPayload: true,
		});
		return { items: points.map((p) => this.payloadToEpisode(p)), nextOffset };
	}

	async getById(id: string): Promise<Episode | null> {
		const { points } = await this.qdrant.scroll(this.collectionName, {
			limit: 1,
			filter: { must: [{ has_id: [id] }] },
			withPayload: true,
		});
		if (points.length === 0) return null;
		return this.payloadToEpisode(points[0]);
	}

	async deleteById(id: string): Promise<void> {
		await this.qdrant.deletePoint(this.collectionName, id);
	}

	async count(): Promise<number> {
		return this.qdrant.countPoints(this.collectionName);
	}

	private payloadToEpisode(result: QdrantSearchResult): Episode {
		const p = result.payload;
		return {
			id: result.id,
			type: (p.type as Episode["type"]) ?? "task",
			summary: (p.summary as string) ?? "",
			detail: (p.detail as string) ?? "",
			parent_id: (p.parent_id as string | null) ?? null,
			session_id: (p.session_id as string) ?? "",
			user_id: (p.user_id as string) ?? "",
			tools_used: (p.tools_used as string[]) ?? [],
			files_touched: (p.files_touched as string[]) ?? [],
			outcome: (p.outcome as Episode["outcome"]) ?? "success",
			outcome_detail: (p.outcome_detail as string) ?? "",
			lessons: (p.lessons as string[]) ?? [],
			started_at: p.started_at ? new Date(p.started_at as number).toISOString() : "",
			ended_at: p.ended_at ? new Date(p.ended_at as number).toISOString() : "",
			duration_seconds: (p.duration_seconds as number) ?? 0,
			importance: (p.importance as number) ?? 0.5,
			access_count: (p.access_count as number) ?? 0,
			last_accessed_at: (p.last_accessed_at as string) ?? "",
			decay_rate: (p.decay_rate as number) ?? 1.0,
		};
	}
}
