import type { MemoryConfig } from "../config/types.ts";
import type { QdrantPoint, QdrantSearchResult, SparseVector } from "./types.ts";

type VectorConfig = Record<string, { size: number; distance: string }>;
type SparseVectorConfig = Record<string, { index?: { on_disk?: boolean } }>;

type CollectionSchema = {
	vectors: VectorConfig;
	sparse_vectors?: SparseVectorConfig;
};

type QdrantResponse = {
	status?: string;
	result?: unknown;
	time?: number;
};

type QdrantQueryResponse = {
	result?: { points?: QdrantScoredPoint[] };
};

type QdrantScoredPoint = {
	id: string | number;
	score: number;
	payload?: Record<string, unknown>;
};

export class QdrantClient {
	private baseUrl: string;

	constructor(config: MemoryConfig) {
		this.baseUrl = config.qdrant.url;
	}

	async createCollection(name: string, schema: CollectionSchema): Promise<void> {
		const existing = await this.collectionExists(name);
		if (existing) return;

		const response = await this.request("PUT", `/collections/${name}`, schema);

		if (response.status !== "ok" && response.result !== true) {
			throw new Error(`Failed to create collection "${name}": ${JSON.stringify(response)}`);
		}
	}

	async collectionExists(name: string): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/collections/${name}`, {
				signal: AbortSignal.timeout(5000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	async upsert(collection: string, points: QdrantPoint[]): Promise<void> {
		const qdrantPoints = points.map((p) => {
			const vector: Record<string, number[] | { indices: number[]; values: number[] }> = {};

			for (const [key, vec] of Object.entries(p.vector)) {
				if (Array.isArray(vec)) {
					vector[key] = vec;
				} else {
					vector[key] = { indices: vec.indices, values: vec.values };
				}
			}

			return {
				id: p.id,
				vector,
				payload: p.payload,
			};
		});

		await this.request("PUT", `/collections/${collection}/points?wait=true`, {
			points: qdrantPoints,
		});
	}

	async search(
		collection: string,
		options: {
			denseVector?: number[];
			denseVectorName?: string;
			sparseVector?: SparseVector;
			sparseVectorName?: string;
			filter?: Record<string, unknown>;
			limit?: number;
			withPayload?: boolean;
		},
	): Promise<QdrantSearchResult[]> {
		const limit = options.limit ?? 10;
		const withPayload = options.withPayload ?? true;
		const hasDense = options.denseVector && options.denseVectorName;
		const hasSparse = options.sparseVector && options.sparseVectorName && options.sparseVector.indices.length > 0;

		if (!hasDense && !hasSparse) {
			return [];
		}

		// Hybrid search with RRF if both vectors present
		if (hasDense && hasSparse) {
			return this.hybridSearch(collection, {
				denseVector: options.denseVector as number[],
				denseVectorName: options.denseVectorName as string,
				sparseVector: options.sparseVector as SparseVector,
				sparseVectorName: options.sparseVectorName as string,
				filter: options.filter,
				limit,
				withPayload,
			});
		}

		// Dense-only search
		if (hasDense) {
			return this.denseSearch(collection, {
				vector: options.denseVector as number[],
				vectorName: options.denseVectorName as string,
				filter: options.filter,
				limit,
				withPayload,
			});
		}

		// Sparse-only search
		return this.sparseSearch(collection, {
			vector: options.sparseVector as SparseVector,
			vectorName: options.sparseVectorName as string,
			filter: options.filter,
			limit,
			withPayload,
		});
	}

	async deletePoint(collection: string, id: string): Promise<void> {
		await this.request("POST", `/collections/${collection}/points/delete`, {
			points: [id],
		});
	}

	async scroll(
		collection: string,
		opts: {
			limit: number;
			offset?: string | number;
			filter?: Record<string, unknown>;
			orderBy?: { key: string; direction: "asc" | "desc" };
			withPayload?: boolean;
		},
	): Promise<{ points: QdrantSearchResult[]; nextOffset: string | number | null }> {
		const body: Record<string, unknown> = {
			limit: opts.limit,
			with_payload: opts.withPayload ?? true,
		};
		if (opts.offset !== undefined) body.offset = opts.offset;
		if (opts.filter) body.filter = opts.filter;
		if (opts.orderBy) body.order_by = { key: opts.orderBy.key, direction: opts.orderBy.direction };

		const response = (await this.request("POST", `/collections/${collection}/points/scroll`, body)) as {
			result?: {
				points?: Array<{ id: string | number; payload?: Record<string, unknown>; vector?: unknown }>;
				next_page_offset?: string | number | null;
			};
		};

		const rawPoints = response.result?.points ?? [];
		const points: QdrantSearchResult[] = rawPoints.map((p) => ({
			id: String(p.id),
			score: 0,
			payload: p.payload ?? {},
		}));
		const nextOffset = response.result?.next_page_offset ?? null;
		return { points, nextOffset };
	}

	async countPoints(collection: string, exact = true): Promise<number> {
		const response = (await this.request("POST", `/collections/${collection}/points/count`, {
			exact,
		})) as { result?: { count?: number } };
		return response.result?.count ?? 0;
	}

	async updatePayload(collection: string, id: string, payload: Record<string, unknown>): Promise<void> {
		await this.request("POST", `/collections/${collection}/points/payload`, {
			payload,
			points: [id],
		});
	}

	async createPayloadIndex(
		collection: string,
		fieldName: string,
		fieldType: "keyword" | "integer" | "float" | "text",
	): Promise<void> {
		await this.request("PUT", `/collections/${collection}/index`, {
			field_name: fieldName,
			field_schema: fieldType,
		});
	}

	async isHealthy(): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/`, {
				signal: AbortSignal.timeout(3000),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	private async hybridSearch(
		collection: string,
		options: {
			denseVector: number[];
			denseVectorName: string;
			sparseVector: SparseVector;
			sparseVectorName: string;
			filter?: Record<string, unknown>;
			limit: number;
			withPayload: boolean;
		},
	): Promise<QdrantSearchResult[]> {
		return this.queryPoints(collection, {
			prefetch: [
				{ query: options.denseVector, using: options.denseVectorName, limit: options.limit * 2 },
				{
					query: { indices: options.sparseVector.indices, values: options.sparseVector.values },
					using: options.sparseVectorName,
					limit: options.limit * 2,
				},
			],
			query: { fusion: "rrf" },
			limit: options.limit,
			with_payload: options.withPayload,
			filter: options.filter,
		});
	}

	private async denseSearch(
		collection: string,
		options: {
			vector: number[];
			vectorName: string;
			filter?: Record<string, unknown>;
			limit: number;
			withPayload: boolean;
		},
	): Promise<QdrantSearchResult[]> {
		return this.queryPoints(collection, {
			query: options.vector,
			using: options.vectorName,
			limit: options.limit,
			with_payload: options.withPayload,
			filter: options.filter,
		});
	}

	private async sparseSearch(
		collection: string,
		options: {
			vector: SparseVector;
			vectorName: string;
			filter?: Record<string, unknown>;
			limit: number;
			withPayload: boolean;
		},
	): Promise<QdrantSearchResult[]> {
		return this.queryPoints(collection, {
			query: { indices: options.vector.indices, values: options.vector.values },
			using: options.vectorName,
			limit: options.limit,
			with_payload: options.withPayload,
			filter: options.filter,
		});
	}

	private async queryPoints(collection: string, body: Record<string, unknown>): Promise<QdrantSearchResult[]> {
		const filtered = { ...body };
		if (!filtered.filter) filtered.filter = undefined;
		const response = (await this.request(
			"POST",
			`/collections/${collection}/points/query`,
			filtered,
		)) as QdrantQueryResponse;
		return this.extractResults(response);
	}

	private extractResults(response: QdrantQueryResponse): QdrantSearchResult[] {
		const points = response.result?.points ?? [];
		return points.map((p) => ({
			id: String(p.id),
			score: p.score,
			payload: p.payload ?? {},
		}));
	}

	private async request(
		method: string,
		path: string,
		body?: Record<string, unknown>,
	): Promise<QdrantResponse & Record<string, unknown>> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(30000),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${text || response.statusText}`);
		}

		return (await response.json()) as QdrantResponse & Record<string, unknown>;
	}
}
