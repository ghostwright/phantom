import { afterAll, describe, expect, mock, test } from "bun:test";
import type { MemoryConfig } from "../../config/types.ts";
import { QdrantClient } from "../qdrant-client.ts";

const TEST_CONFIG: MemoryConfig = {
	qdrant: { url: "http://localhost:6333" },
	ollama: { url: "http://localhost:11434", model: "nomic-embed-text" },
	collections: { episodes: "episodes", semantic_facts: "semantic_facts", procedures: "procedures" },
	embedding: { dimensions: 768, batch_size: 32 },
	context: { max_tokens: 50000, episode_limit: 10, fact_limit: 20, procedure_limit: 5 },
};

describe("QdrantClient", () => {
	const originalFetch = globalThis.fetch;

	afterAll(() => {
		globalThis.fetch = originalFetch;
	});

	test("createCollection sends PUT with correct schema", async () => {
		const calls: { url: string; method: string; body: string }[] = [];

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			const urlStr = typeof url === "string" ? url : url.url;

			// collectionExists check returns 404 (doesn't exist)
			if (init?.method === undefined || init?.method === "GET") {
				return Promise.resolve(new Response("", { status: 404 }));
			}

			calls.push({
				url: urlStr,
				method: init?.method ?? "GET",
				body: init?.body as string,
			});

			return Promise.resolve(
				new Response(JSON.stringify({ status: "ok", result: true }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.createCollection("test_collection", {
			vectors: {
				summary: { size: 768, distance: "Cosine" },
			},
			sparse_vectors: {
				text_bm25: {},
			},
		});

		expect(calls.length).toBe(1);
		expect(calls[0].url).toContain("/collections/test_collection");
		expect(calls[0].method).toBe("PUT");

		const body = JSON.parse(calls[0].body);
		expect(body.vectors.summary.size).toBe(768);
		expect(body.sparse_vectors.text_bm25).toBeDefined();
	});

	test("createCollection skips if collection already exists", async () => {
		let putCalled = false;

		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.method === "PUT") {
				putCalled = true;
			}
			// collectionExists returns 200 (exists)
			return Promise.resolve(
				new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.createCollection("existing", { vectors: {} });

		expect(putCalled).toBe(false);
	});

	test("upsert sends points with named vectors", async () => {
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ status: "ok", result: { operation_id: 1 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.upsert("episodes", [
			{
				id: "test-id",
				vector: {
					summary: [0.1, 0.2, 0.3],
					text_bm25: { indices: [1, 42], values: [0.5, 0.8] },
				},
				payload: { type: "task", summary: "test" },
			},
		]);

		const body = capturedBody as unknown as Record<string, unknown>;
		expect(body).not.toBeNull();
		const points = body.points as Array<Record<string, unknown>>;
		expect(points.length).toBe(1);
		expect(points[0].id).toBe("test-id");
		expect((points[0].vector as Record<string, unknown>).summary).toEqual([0.1, 0.2, 0.3]);
		expect((points[0].vector as Record<string, unknown>).text_bm25).toEqual({ indices: [1, 42], values: [0.5, 0.8] });
	});

	test("search with hybrid search sends prefetch+RRF", async () => {
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(
					JSON.stringify({
						result: {
							points: [
								{ id: "result-1", score: 0.95, payload: { summary: "test memory" } },
								{ id: "result-2", score: 0.8, payload: { summary: "another memory" } },
							],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		const results = await client.search("episodes", {
			denseVector: [0.1, 0.2, 0.3],
			denseVectorName: "summary",
			sparseVector: { indices: [1, 42], values: [0.5, 0.8] },
			sparseVectorName: "text_bm25",
			limit: 5,
		});

		expect(results.length).toBe(2);
		expect(results[0].id).toBe("result-1");
		expect(results[0].score).toBe(0.95);
		expect(results[0].payload.summary).toBe("test memory");

		// Verify hybrid search structure
		const hybridBody = capturedBody as unknown as Record<string, unknown>;
		expect(hybridBody).not.toBeNull();
		expect(hybridBody.prefetch).toBeDefined();
		expect((hybridBody.query as Record<string, unknown>).fusion).toBe("rrf");
	});

	test("search with dense-only sends direct query", async () => {
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ result: { points: [] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.search("episodes", {
			denseVector: [0.1, 0.2],
			denseVectorName: "summary",
			limit: 5,
		});

		const denseBody = capturedBody as unknown as Record<string, unknown>;
		expect(denseBody).not.toBeNull();
		expect(denseBody.query).toEqual([0.1, 0.2]);
		expect(denseBody.using).toBe("summary");
		expect(denseBody.prefetch).toBeUndefined();
	});

	test("search returns empty array when no vectors provided", async () => {
		const client = new QdrantClient(TEST_CONFIG);
		const results = await client.search("episodes", { limit: 5 });
		expect(results).toEqual([]);
	});

	test("isHealthy returns true when Qdrant responds", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response('{"title":"ok"}', { status: 200 })),
		) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		expect(await client.isHealthy()).toBe(true);
	});

	test("isHealthy returns false when Qdrant is down", async () => {
		globalThis.fetch = mock(() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		expect(await client.isHealthy()).toBe(false);
	});

	test("deletePoint sends correct request", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			capturedUrl = typeof url === "string" ? url : url.url;
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			}
			return Promise.resolve(
				new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.deletePoint("episodes", "point-123");

		expect(capturedUrl).toContain("/collections/episodes/points/delete");
		const deleteBody = capturedBody as unknown as Record<string, unknown>;
		expect(deleteBody).not.toBeNull();
		expect(deleteBody.points).toEqual(["point-123"]);
	});

	test("scroll sends filter and returns matching points", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | null = null;

		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			capturedUrl = typeof url === "string" ? url : url.url;
			if (init?.body) {
				capturedBody = JSON.parse(init.body as string);
			}

			return Promise.resolve(
				new Response(
					JSON.stringify({
						result: {
							points: [{ id: "stale-ep", score: 0, payload: { summary: "old memory" } }],
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		const results = await client.scroll("episodes", {
			filter: { must: [{ key: "user_id", match: { value: "user-1" } }] },
			limit: 5,
			withPayload: true,
		});

		expect(capturedUrl).toContain("/collections/episodes/points/scroll");
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe("stale-ep");
		expect((capturedBody as unknown as Record<string, unknown>).limit).toBe(5);
	});
});
