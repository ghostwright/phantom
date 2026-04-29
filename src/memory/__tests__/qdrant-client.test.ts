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

	test("scroll sends POST to points/scroll with limit and with_payload defaults", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | null = null;
		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			capturedUrl = typeof url === "string" ? url : url.url;
			if (init?.body) capturedBody = JSON.parse(init.body as string);
			return Promise.resolve(
				new Response(
					JSON.stringify({
						result: {
							points: [{ id: "p1", payload: { a: 1 } }],
							next_page_offset: "cursor-1",
						},
						status: "ok",
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		const res = await client.scroll("episodes", { limit: 20 });

		expect(capturedUrl).toContain("/collections/episodes/points/scroll");
		const body = capturedBody as unknown as Record<string, unknown>;
		expect(body.limit).toBe(20);
		expect(body.with_payload).toBe(true);
		expect(body.offset).toBeUndefined();
		expect(body.filter).toBeUndefined();
		expect(body.order_by).toBeUndefined();
		expect(res.points.length).toBe(1);
		expect(res.points[0].id).toBe("p1");
		expect(res.points[0].score).toBe(0);
		expect(res.points[0].payload.a).toBe(1);
		expect(res.nextOffset).toBe("cursor-1");
	});

	test("scroll passes offset, filter, and order_by through", async () => {
		let capturedBody: Record<string, unknown> | null = null;
		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.body) capturedBody = JSON.parse(init.body as string);
			return Promise.resolve(
				new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.scroll("facts", {
			limit: 10,
			offset: "cursor-abc",
			filter: { must: [{ key: "category", match: { value: "domain_knowledge" } }] },
			orderBy: { key: "valid_from", direction: "desc" },
			withPayload: true,
		});

		const body = capturedBody as unknown as Record<string, unknown>;
		expect(body.limit).toBe(10);
		expect(body.offset).toBe("cursor-abc");
		expect((body.order_by as Record<string, string>).key).toBe("valid_from");
		expect((body.order_by as Record<string, string>).direction).toBe("desc");
		const filter = body.filter as { must: Array<Record<string, unknown>> };
		expect(filter.must[0].key).toBe("category");
	});

	test("scroll returns nextOffset null when response lacks cursor", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ result: { points: [{ id: 42, payload: {} }] } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		const res = await client.scroll("episodes", { limit: 5 });
		expect(res.nextOffset).toBeNull();
		expect(res.points[0].id).toBe("42");
	});

	test("scroll paginates through pages", async () => {
		const pages = [
			{ result: { points: [{ id: "a", payload: {} }], next_page_offset: "cursor-2" } },
			{ result: { points: [{ id: "b", payload: {} }], next_page_offset: null } },
		];
		let call = 0;
		globalThis.fetch = mock(() => {
			const body = pages[call];
			call += 1;
			return Promise.resolve(
				new Response(JSON.stringify(body), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		const page1 = await client.scroll("episodes", { limit: 1 });
		expect(page1.nextOffset).toBe("cursor-2");
		const page2 = await client.scroll("episodes", { limit: 1, offset: page1.nextOffset as string });
		expect(page2.nextOffset).toBeNull();
		expect(page2.points[0].id).toBe("b");
	});

	test("scroll throws on Qdrant error", async () => {
		globalThis.fetch = mock(() => Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await expect(client.scroll("episodes", { limit: 5 })).rejects.toThrow(/scroll/);
	});

	test("scroll with_payload=false sends the override", async () => {
		let capturedBody: Record<string, unknown> | null = null;
		globalThis.fetch = mock((_url: string | Request, init?: RequestInit) => {
			if (init?.body) capturedBody = JSON.parse(init.body as string);
			return Promise.resolve(
				new Response(JSON.stringify({ result: { points: [], next_page_offset: null } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		await client.scroll("episodes", { limit: 5, withPayload: false });
		expect(capturedBody).not.toBeNull();
		const body = capturedBody as unknown as Record<string, unknown>;
		expect(body.with_payload).toBe(false);
	});

	test("countPoints returns the count from the exact response", async () => {
		let capturedUrl = "";
		let capturedBody: Record<string, unknown> | null = null;
		globalThis.fetch = mock((url: string | Request, init?: RequestInit) => {
			capturedUrl = typeof url === "string" ? url : url.url;
			if (init?.body) capturedBody = JSON.parse(init.body as string);
			return Promise.resolve(
				new Response(JSON.stringify({ result: { count: 412 } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		const n = await client.countPoints("episodes");
		expect(n).toBe(412);
		expect(capturedUrl).toContain("/collections/episodes/points/count");
		expect(capturedBody).not.toBeNull();
		const countBody = capturedBody as unknown as Record<string, unknown>;
		expect(countBody.exact).toBe(true);
	});

	test("countPoints returns 0 when result is missing", async () => {
		globalThis.fetch = mock(() =>
			Promise.resolve(
				new Response(JSON.stringify({ status: "ok" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			),
		) as unknown as typeof fetch;

		const client = new QdrantClient(TEST_CONFIG);
		expect(await client.countPoints("episodes")).toBe(0);
	});
});
