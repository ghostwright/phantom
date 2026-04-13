import { afterAll, describe, expect, mock, test } from "bun:test";
import type { MemoryConfig } from "../../config/types.ts";
import { EmbeddingClient } from "../embeddings.ts";
import { QdrantClient } from "../qdrant-client.ts";
import { SemanticStore } from "../semantic.ts";

const TEST_CONFIG: MemoryConfig = {
	qdrant: { url: "http://localhost:6333" },
	ollama: { url: "http://localhost:11434", model: "nomic-embed-text" },
	collections: { episodes: "episodes", semantic_facts: "semantic_facts", procedures: "procedures" },
	embedding: { dimensions: 768, batch_size: 32 },
	context: { max_tokens: 50000, episode_limit: 10, fact_limit: 20, procedure_limit: 5 },
};

describe("SemanticStore retention", () => {
	const originalFetch = globalThis.fetch;

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	test("pruneExpiredFacts deletes superseded facts past the retention window", async () => {
		const deletedIds: string[] = [];
		let scrollBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.url;

			if (urlStr.includes("/points/scroll")) {
				scrollBody = JSON.parse(init?.body as string);
				return Promise.resolve(
					new Response(
						JSON.stringify({
							result: {
								points: [{ id: "expired-fact", score: 0, payload: {} }],
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
				);
			}

			if (urlStr.includes("/points/delete")) {
				const body = JSON.parse(init?.body as string) as { points: string[] };
				deletedIds.push(body.points[0]);
			}

			return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
		}) as unknown as typeof fetch;

		const qdrant = new QdrantClient(TEST_CONFIG);
		const embedder = new EmbeddingClient(TEST_CONFIG);
		const store = new SemanticStore(qdrant, embedder, TEST_CONFIG);

		const pruned = await store.pruneExpiredFacts(new Date("2026-03-31T00:00:00.000Z").toISOString());

		expect(pruned).toBe(1);
		expect(deletedIds).toEqual(["expired-fact"]);

		const filter = ((scrollBody as unknown as Record<string, unknown>).filter ?? {}) as {
			must: Array<Record<string, unknown>>;
		};
		expect(filter.must).toEqual([{ key: "valid_until", range: expect.any(Object) }]);
	});
});
