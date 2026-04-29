import type { MemoryConfig } from "../config/types.ts";
import { type EmbeddingClient, textToSparseVector } from "./embeddings.ts";
import type { QdrantClient } from "./qdrant-client.ts";
import type { Procedure, QdrantSearchResult } from "./types.ts";

const COLLECTION_SCHEMA = {
	vectors: {
		description: { size: 768, distance: "Cosine" },
	},
	sparse_vectors: {
		text_bm25: {},
	},
} as const;

const PAYLOAD_INDEXES: { field: string; type: "keyword" | "integer" | "float" }[] = [
	{ field: "name", type: "keyword" },
	{ field: "confidence", type: "float" },
	{ field: "success_count", type: "integer" },
	{ field: "failure_count", type: "integer" },
	{ field: "last_used_at", type: "integer" },
];

export class ProceduralStore {
	private qdrant: QdrantClient;
	private embedder: EmbeddingClient;
	private collectionName: string;

	constructor(qdrant: QdrantClient, embedder: EmbeddingClient, config: MemoryConfig) {
		this.qdrant = qdrant;
		this.embedder = embedder;
		this.collectionName = config.collections.procedures;
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

	async store(procedure: Procedure): Promise<string> {
		const embeddingText = `${procedure.description} ${procedure.trigger}`;
		const descVec = await this.embedder.embed(embeddingText);
		const sparse = textToSparseVector(embeddingText);

		await this.qdrant.upsert(this.collectionName, [
			{
				id: procedure.id,
				vector: {
					description: descVec,
					text_bm25: sparse,
				},
				payload: {
					name: procedure.name,
					description: procedure.description,
					trigger: procedure.trigger,
					steps: procedure.steps,
					preconditions: procedure.preconditions,
					postconditions: procedure.postconditions,
					parameters: procedure.parameters,
					source_episode_ids: procedure.source_episode_ids,
					success_count: procedure.success_count,
					failure_count: procedure.failure_count,
					last_used_at: new Date(procedure.last_used_at).getTime(),
					confidence: procedure.confidence,
					version: procedure.version,
				},
			},
		]);

		return procedure.id;
	}

	async find(taskDescription: string): Promise<Procedure | null> {
		const queryVec = await this.embedder.embed(taskDescription);
		const sparse = textToSparseVector(taskDescription);

		const results = await this.qdrant.search(this.collectionName, {
			denseVector: queryVec,
			denseVectorName: "description",
			sparseVector: sparse,
			sparseVectorName: "text_bm25",
			limit: 1,
			withPayload: true,
		});

		if (results.length === 0 || results[0].score < 0.3) {
			return null;
		}

		return this.payloadToProcedure(results[0]);
	}

	async updateOutcome(id: string, success: boolean): Promise<void> {
		const field = success ? "success_count" : "failure_count";
		await this.qdrant.updatePayload(this.collectionName, id, {
			[field]: { $inc: 1 },
			last_used_at: Date.now(),
		});
	}

	async scroll(opts: {
		limit: number;
		offset?: string | number;
	}): Promise<{ items: Procedure[]; nextOffset: string | number | null }> {
		const { points, nextOffset } = await this.qdrant.scroll(this.collectionName, {
			limit: opts.limit,
			offset: opts.offset,
			orderBy: { key: "last_used_at", direction: "desc" },
			withPayload: true,
		});
		return { items: points.map((p) => this.payloadToProcedure(p)), nextOffset };
	}

	async getById(id: string): Promise<Procedure | null> {
		const { points } = await this.qdrant.scroll(this.collectionName, {
			limit: 1,
			filter: { must: [{ has_id: [id] }] },
			withPayload: true,
		});
		if (points.length === 0) return null;
		return this.payloadToProcedure(points[0]);
	}

	async deleteById(id: string): Promise<void> {
		await this.qdrant.deletePoint(this.collectionName, id);
	}

	async count(): Promise<number> {
		return this.qdrant.countPoints(this.collectionName);
	}

	private payloadToProcedure(result: QdrantSearchResult): Procedure {
		const p = result.payload;
		return {
			id: result.id,
			name: (p.name as string) ?? "",
			description: (p.description as string) ?? "",
			trigger: (p.trigger as string) ?? "",
			steps: (p.steps as Procedure["steps"]) ?? [],
			preconditions: (p.preconditions as string[]) ?? [],
			postconditions: (p.postconditions as string[]) ?? [],
			parameters: (p.parameters as Procedure["parameters"]) ?? {},
			source_episode_ids: (p.source_episode_ids as string[]) ?? [],
			success_count: (p.success_count as number) ?? 0,
			failure_count: (p.failure_count as number) ?? 0,
			last_used_at: p.last_used_at ? new Date(p.last_used_at as number).toISOString() : "",
			confidence: (p.confidence as number) ?? 0.5,
			version: (p.version as number) ?? 1,
		};
	}
}
