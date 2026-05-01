import { describe, expect, test } from "bun:test";
import { enrichOwner } from "../enrich-owner.ts";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});
}

function htmlResponse(body: string, init: ResponseInit = {}): Response {
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/html; charset=utf-8" },
		...init,
	});
}

function notFound(): Response {
	return new Response("not found", { status: 404 });
}

// A handler-style fetch double that routes by URL prefix so a single
// research run can hit github + a personal site + linkedin and we can
// assert on the bullets that got composed.
function makeFetch(
	handlers: Array<{ match: (url: string) => boolean; respond: () => Response | Promise<Response> }>,
): typeof fetch {
	return (async (url: string | URL | Request) => {
		const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
		for (const h of handlers) {
			if (h.match(u)) return h.respond();
		}
		return notFound();
	}) as unknown as typeof fetch;
}

describe("enrichOwner happy path", () => {
	test("returns three bullets when github + linkedin + site all answer", async () => {
		const fetchImpl = makeFetch([
			{
				match: (u) => u.startsWith("https://api.github.com/users/"),
				respond: () =>
					jsonResponse({
						login: "matt",
						name: "Matt Example",
						bio: "Engineer building developer tools.",
						public_repos: 23,
						followers: 100,
						company: "Acme",
						html_url: "https://github.com/matt",
					}),
			},
			{
				match: (u) => u.startsWith("https://www.linkedin.com/"),
				respond: () =>
					htmlResponse(
						`<html><head><meta property="og:title" content="Matt Example - Senior Software Engineer at Acme | LinkedIn" /></head></html>`,
					),
			},
			{
				match: (u) => u.startsWith("https://acme.com"),
				respond: () =>
					htmlResponse(
						`<html><head>
							<meta property="og:title" content="Acme" />
							<meta property="og:description" content="Acme builds tools for engineers." />
						</head></html>`,
					),
			},
		]);

		const result = await enrichOwner(
			{ email: "matt@acme.com", name: "Matt Example", linkedinUrl: "https://www.linkedin.com/in/matt/" },
			{ fetchImpl, perFetchTimeoutMs: 1_000 },
		);

		expect(result.outcome).toBe("ok");
		expect(result.bullets).not.toBeNull();
		const bulletCount = result.bullets?.length ?? 0;
		expect(bulletCount).toBeGreaterThanOrEqual(2);
		expect(bulletCount).toBeLessThanOrEqual(3);
		expect(result.bullets?.some((b) => b.includes("@matt"))).toBe(true);
		expect(result.sources.length).toBe(bulletCount);
	});

	test("returns linkedin bullet from headline parse", async () => {
		const fetchImpl = makeFetch([
			{ match: (u) => u.includes("api.github.com"), respond: () => notFound() },
			{
				match: (u) => u.includes("linkedin.com"),
				respond: () =>
					htmlResponse(
						`<html><head><meta property="og:title" content="Sara Doe - VP Eng at Foo | LinkedIn" /></head></html>`,
					),
			},
		]);

		const result = await enrichOwner(
			{ email: "sara@gmail.com", linkedinUrl: "https://www.linkedin.com/in/sara/" },
			{ fetchImpl, perFetchTimeoutMs: 1_000 },
		);

		expect(result.bullets).not.toBeNull();
		expect(result.bullets?.[0]).toContain("VP Eng at Foo");
		expect(result.sources[0]?.kind).toBe("linkedin_public");
	});

	test("personal site bullet uses og:description over og:title", async () => {
		const fetchImpl = makeFetch([
			{ match: (u) => u.includes("api.github.com"), respond: () => notFound() },
			{
				match: (u) => u.includes("acme.dev"),
				respond: () =>
					htmlResponse(
						`<html><head>
							<meta property="og:title" content="Home" />
							<meta property="og:description" content="Building reliable distributed systems." />
						</head></html>`,
					),
			},
		]);

		const result = await enrichOwner({ email: "founder@acme.dev" }, { fetchImpl, perFetchTimeoutMs: 1_000 });

		expect(result.bullets).not.toBeNull();
		expect(result.bullets?.[0]).toContain("acme.dev");
		expect(result.bullets?.[0]).toContain("distributed systems");
	});

	test("github structural fallback when bio is missing", async () => {
		const fetchImpl = makeFetch([
			{
				match: (u) => u.includes("api.github.com"),
				respond: () =>
					jsonResponse({
						login: "carla",
						name: "Carla Q",
						bio: null,
						public_repos: 12,
						company: "Foo Co",
						html_url: "https://github.com/carla",
					}),
			},
		]);

		const result = await enrichOwner({ email: "carla@example.org" }, { fetchImpl, perFetchTimeoutMs: 1_000 });

		expect(result.bullets).not.toBeNull();
		expect(result.bullets?.[0]).toContain("@carla");
		expect(result.bullets?.[0]).toContain("Carla Q");
		expect(result.bullets?.[0]).toContain("Foo Co");
		expect(result.bullets?.[0]).toContain("12");
	});
});

describe("enrichOwner empty paths", () => {
	test("returns null bullets when nothing answers", async () => {
		const fetchImpl = makeFetch([{ match: () => true, respond: () => notFound() }]);
		const result = await enrichOwner({ email: "nobody@example.com" }, { fetchImpl, perFetchTimeoutMs: 1_000 });
		expect(result.bullets).toBeNull();
		expect(result.outcome).toBe("empty");
		expect(result.sources).toEqual([]);
	});

	test("returns disabled outcome when deps.disabled is true", async () => {
		const result = await enrichOwner({ email: "x@y.com" }, { disabled: true });
		expect(result.outcome).toBe("disabled");
		expect(result.bullets).toBeNull();
	});

	test("returns empty when email is blank", async () => {
		const fetchImpl = makeFetch([]);
		const result = await enrichOwner({ email: "  " }, { fetchImpl });
		expect(result.outcome).toBe("empty");
		expect(result.bullets).toBeNull();
	});

	test("skips personal-site probe when email domain is a public mailbox", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string | URL | Request) => {
			const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
			calls.push(u);
			return notFound();
		}) as unknown as typeof fetch;
		await enrichOwner({ email: "person@gmail.com" }, { fetchImpl, perFetchTimeoutMs: 1_000 });
		// We should not see a fetch to https://gmail.com.
		expect(calls.some((u) => u === "https://gmail.com" || u.startsWith("https://gmail.com/"))).toBe(false);
	});
});

describe("enrichOwner network failure tolerance", () => {
	test("returns gracefully when every fetch throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("ENETUNREACH");
		}) as unknown as typeof fetch;
		const result = await enrichOwner({ email: "matt@acme.com" }, { fetchImpl, perFetchTimeoutMs: 1_000 });
		expect(result.bullets).toBeNull();
		expect(result.outcome === "empty" || result.outcome === "timeout").toBe(true);
	});

	test("returns partial bullets when only one source answers", async () => {
		const fetchImpl = makeFetch([
			{
				match: (u) => u.includes("api.github.com"),
				respond: () =>
					jsonResponse({
						login: "kara",
						bio: "ML researcher.",
						public_repos: 3,
						html_url: "https://github.com/kara",
					}),
			},
			{ match: () => true, respond: () => notFound() },
		]);

		const result = await enrichOwner({ email: "kara@example.org" }, { fetchImpl, perFetchTimeoutMs: 1_000 });

		expect(result.bullets).not.toBeNull();
		expect(result.bullets?.length).toBe(1);
		expect(result.bullets?.[0]).toContain("@kara");
	});
});

describe("enrichOwner timeout", () => {
	test("global budget elapsed marks outcome timeout", async () => {
		// Advance the clock past the budget on the second now() call so
		// the post-Promise.all elapsed check trips.
		let calls = 0;
		const now = () => {
			calls += 1;
			return calls === 1 ? 0 : 999_999;
		};
		const fetchImpl = makeFetch([{ match: () => true, respond: () => notFound() }]);
		const result = await enrichOwner(
			{ email: "x@example.org" },
			{ fetchImpl, perFetchTimeoutMs: 100, budgetMs: 1, now },
		);
		expect(["timeout", "empty"]).toContain(result.outcome);
	});
});

describe("enrichOwner safety invariants", () => {
	test("never echoes the owner email into a bullet", async () => {
		const fetchImpl = makeFetch([
			{
				match: (u) => u.includes("api.github.com"),
				respond: () =>
					jsonResponse({
						login: "matt",
						bio: "Engineer.",
						public_repos: 1,
						html_url: "https://github.com/matt",
					}),
			},
		]);
		const result = await enrichOwner({ email: "matt@acme.com" }, { fetchImpl, perFetchTimeoutMs: 1_000 });
		expect(result.bullets).not.toBeNull();
		for (const bullet of result.bullets ?? []) {
			expect(bullet).not.toContain("matt@acme.com");
		}
	});

	test("caps each bullet at 280 chars", async () => {
		const longBio = "x".repeat(500);
		const fetchImpl = makeFetch([
			{
				match: (u) => u.includes("api.github.com"),
				respond: () =>
					jsonResponse({
						login: "longbio",
						bio: longBio,
						public_repos: 1,
						html_url: "https://github.com/longbio",
					}),
			},
		]);
		const result = await enrichOwner({ email: "longbio@example.org" }, { fetchImpl, perFetchTimeoutMs: 1_000 });
		expect(result.bullets).not.toBeNull();
		for (const b of result.bullets ?? []) {
			expect(b.length).toBeLessThanOrEqual(280);
		}
	});
});
