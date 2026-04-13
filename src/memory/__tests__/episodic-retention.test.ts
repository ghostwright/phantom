import { afterAll, describe, expect, mock, test } from "bun:test";
import type { MemoryConfig } from "../../config/types.ts";
import { EmbeddingClient } from "../embeddings.ts";
import { EpisodicStore } from "../episodic.ts";
import { QdrantClient } from "../qdrant-client.ts";

const TEST_CONFIG: MemoryConfig = {
	qdrant: { url: "http://localhost:6333" },
	ollama: { url: "http://localhost:11434", model: "nomic-embed-text" },
	collections: { episodes: "episodes", semantic_facts: "semantic_facts", procedures: "procedures" },
	embedding: { dimensions: 768, batch_size: 32 },
	context: { max_tokens: 50000, episode_limit: 10, fact_limit: 20, procedure_limit: 5 },
};

describe("EpisodicStore retention", () => {
	const originalFetch = globalThis.fetch;

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	test("pruneStaleEpisodes deletes low-signal episodes past the retention window", async () => {
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
								points: [
									{ id: "stale-1", score: 0, payload: {} },
									{ id: "stale-2", score: 0, payload: {} },
								],
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
		const store = new EpisodicStore(qdrant, embedder, TEST_CONFIG);

		const pruned = await store.pruneStaleEpisodes("user-1", new Date("2026-03-31T00:00:00.000Z").toISOString());

		expect(pruned).toBe(2);
		expect(deletedIds).toEqual(["stale-1", "stale-2"]);

		const filter = ((scrollBody as unknown as Record<string, unknown>).filter ?? {}) as {
			must: Array<Record<string, unknown>>;
		};
		expect(filter.must).toHaveLength(4);
		expect(filter.must[0]).toEqual({ key: "user_id", match: { value: "user-1" } });
	});
});
