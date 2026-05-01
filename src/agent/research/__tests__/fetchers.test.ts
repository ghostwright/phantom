import { describe, expect, test } from "bun:test";
import { fetchGithubProfile, fetchLinkedinPublic, fetchPageMetadata } from "../fetchers.ts";

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

describe("fetchGithubProfile", () => {
	test("returns null for empty login", async () => {
		const result = await fetchGithubProfile("", {
			fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
		});
		expect(result).toBeNull();
	});

	test("returns null for malformed login", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return jsonResponse({});
		}) as unknown as typeof fetch;
		const result = await fetchGithubProfile("not a real login!", { fetchImpl });
		expect(result).toBeNull();
		expect(calls).toEqual([]);
	});

	test("parses a real GitHub user payload into the public shape", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				login: "octocat",
				name: "The Octocat",
				company: "@github",
				blog: "https://github.blog",
				location: "San Francisco",
				bio: "There once was...",
				public_repos: 8,
				followers: 4000,
				html_url: "https://github.com/octocat",
			})) as unknown as typeof fetch;
		const result = await fetchGithubProfile("octocat", { fetchImpl });
		expect(result).not.toBeNull();
		expect(result?.login).toBe("octocat");
		expect(result?.bio).toBe("There once was...");
		expect(result?.public_repos).toBe(8);
		expect(result?.html_url).toBe("https://github.com/octocat");
	});

	test("normalizes empty string fields to null", async () => {
		const fetchImpl = (async () =>
			jsonResponse({
				login: "octocat",
				name: "",
				company: "  ",
				bio: null,
				html_url: "https://github.com/octocat",
			})) as unknown as typeof fetch;
		const result = await fetchGithubProfile("octocat", { fetchImpl });
		expect(result?.name).toBeNull();
		expect(result?.company).toBeNull();
		expect(result?.bio).toBeNull();
	});

	test("returns null on non-200 response", async () => {
		const fetchImpl = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
		const result = await fetchGithubProfile("octocat", { fetchImpl });
		expect(result).toBeNull();
	});

	test("returns null on malformed JSON", async () => {
		const fetchImpl = (async () =>
			new Response("not json", {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof fetch;
		const result = await fetchGithubProfile("octocat", { fetchImpl });
		expect(result).toBeNull();
	});

	test("returns null when network throws", async () => {
		const fetchImpl = (async () => {
			throw new Error("ENETDOWN");
		}) as unknown as typeof fetch;
		const result = await fetchGithubProfile("octocat", { fetchImpl });
		expect(result).toBeNull();
	});

	test("aborts when external signal already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = (async (_u: unknown, init: RequestInit | undefined) => {
			if (init?.signal?.aborted) throw new Error("aborted");
			return jsonResponse({ login: "x" });
		}) as unknown as typeof fetch;
		const result = await fetchGithubProfile("octocat", { fetchImpl, signal: controller.signal });
		expect(result).toBeNull();
	});
});

describe("fetchPageMetadata", () => {
	test("returns null for empty url", async () => {
		const result = await fetchPageMetadata("", {
			fetchImpl: (async () => htmlResponse("")) as unknown as typeof fetch,
		});
		expect(result).toBeNull();
	});

	test("returns null for non-http url", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return htmlResponse("");
		}) as unknown as typeof fetch;
		const result = await fetchPageMetadata("file:///etc/passwd", { fetchImpl });
		expect(result).toBeNull();
		expect(calls).toEqual([]);
	});

	test("extracts og:title and og:description", async () => {
		const html = `<html><head>
			<meta property="og:title" content="Real Title" />
			<meta property="og:description" content="Real description goes here." />
		</head></html>`;
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		expect(result?.title).toBe("Real Title");
		expect(result?.description).toBe("Real description goes here.");
	});

	test("extracts twitter: tags as fallback", async () => {
		const html = `<html><head>
			<meta name="twitter:title" content="Tw Title" />
			<meta name="twitter:description" content="Tw Desc" />
		</head></html>`;
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		expect(result?.title).toBe("Tw Title");
		expect(result?.description).toBe("Tw Desc");
	});

	test("falls back to <title> tag when no og: tags exist", async () => {
		const html = "<html><head><title>Plain Title</title></head></html>";
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		expect(result?.title).toBe("Plain Title");
		expect(result?.description).toBeNull();
	});

	test("decodes HTML entities in extracted strings", async () => {
		const html = `<html><head>
			<meta property="og:title" content="A &amp; B&#39;s site" />
		</head></html>`;
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		expect(result?.title).toBe("A & B's site");
	});

	test("handles meta tag with content first then property", async () => {
		const html = `<html><head>
			<meta content="Reverse Order" property="og:title" />
		</head></html>`;
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		expect(result?.title).toBe("Reverse Order");
	});

	test("returns null when content-type is not HTML", async () => {
		const fetchImpl = (async () =>
			new Response("PDF binary", {
				status: 200,
				headers: { "content-type": "application/pdf" },
			})) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com/doc.pdf", { fetchImpl });
		expect(result).toBeNull();
	});

	test("returns null when no metadata at all", async () => {
		const fetchImpl = (async () => htmlResponse("<html><body>Hi</body></html>")) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		expect(result).toBeNull();
	});

	test("caps page size at 256KB to defeat memory blowup", async () => {
		const giantHtml = `<title>OK</title>${"X".repeat(2_000_000)}`;
		const fetchImpl = (async () => htmlResponse(giantHtml)) as unknown as typeof fetch;
		const result = await fetchPageMetadata("https://example.com", { fetchImpl });
		// We should still find the title because the cap is post-fetch.
		expect(result?.title).toBe("OK");
	});
});

describe("fetchLinkedinPublic", () => {
	test("returns null for non-LinkedIn URL", async () => {
		const calls: string[] = [];
		const fetchImpl = (async (url: string) => {
			calls.push(url);
			return htmlResponse("");
		}) as unknown as typeof fetch;
		const result = await fetchLinkedinPublic("https://example.com/in/x", { fetchImpl });
		expect(result).toBeNull();
		expect(calls).toEqual([]);
	});

	test("accepts www.linkedin.com", async () => {
		const html = `<html><head>
			<meta property="og:title" content="Person - Engineer | LinkedIn" />
		</head></html>`;
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchLinkedinPublic("https://www.linkedin.com/in/person/", { fetchImpl });
		expect(result).not.toBeNull();
		expect(result?.title).toContain("Engineer");
	});

	test("accepts bare linkedin.com host", async () => {
		const html = `<html><head><meta property="og:title" content="Person - Engineer" /></head></html>`;
		const fetchImpl = (async () => htmlResponse(html)) as unknown as typeof fetch;
		const result = await fetchLinkedinPublic("https://linkedin.com/in/person/", { fetchImpl });
		expect(result).not.toBeNull();
	});

	test("returns null when LinkedIn answers with 999 (rate limit)", async () => {
		const fetchImpl = (async () =>
			new Response("", { status: 999, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
		const result = await fetchLinkedinPublic("https://www.linkedin.com/in/x", { fetchImpl });
		expect(result).toBeNull();
	});
});
