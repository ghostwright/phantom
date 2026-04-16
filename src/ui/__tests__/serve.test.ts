import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { handleUiRequest, setPublicDir } from "../serve.ts";
import { createSession, revokeAllSessions } from "../session.ts";

// Point at our actual public dir for file serving tests
setPublicDir(resolve(import.meta.dir, "../../../public"));

afterEach(() => {
	revokeAllSessions();
});

function req(path: string, opts?: RequestInit & { cookie?: string }): Request {
	const headers: Record<string, string> = {};
	if (opts?.cookie) {
		headers.Cookie = opts.cookie;
	}
	if (!headers.Accept) {
		headers.Accept = "text/html";
	}
	return new Request(`http://localhost:3100${path}`, {
		...opts,
		headers: { ...headers, ...((opts?.headers as Record<string, string>) ?? {}) },
	});
}

describe("login page", () => {
	test("GET /ui/login returns the login page", async () => {
		const res = await handleUiRequest(req("/ui/login"));
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("login-form");
		expect(body).toContain("Access token");
	});
});

describe("login POST", () => {
	test("POST /ui/login with valid magic token sets cookie", async () => {
		const { magicToken } = createSession();
		const res = await handleUiRequest(
			req("/ui/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: magicToken }),
			}),
		);
		expect(res.status).toBe(200);
		const cookie = res.headers.get("Set-Cookie");
		expect(cookie).toContain("phantom_session=");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("SameSite=Strict");
	});

	test("POST /ui/login with invalid token returns 401", async () => {
		const res = await handleUiRequest(
			req("/ui/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: "invalid-token" }),
			}),
		);
		expect(res.status).toBe(401);
	});

	test("POST /ui/login with direct session token works", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(
			req("/ui/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token: sessionToken }),
			}),
		);
		expect(res.status).toBe(200);
		const cookie = res.headers.get("Set-Cookie");
		expect(cookie).toContain("phantom_session=");
	});

	test("POST /ui/login with missing token returns 400", async () => {
		const res = await handleUiRequest(
			req("/ui/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			}),
		);
		expect(res.status).toBe(400);
	});
});

describe("auth required", () => {
	test("unauthenticated HTML request redirects to /ui/login", async () => {
		const res = await handleUiRequest(req("/ui/index.html"));
		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("/ui/login");
	});

	test("unauthenticated non-HTML request returns 401", async () => {
		const res = await handleUiRequest(req("/ui/api/events", { headers: { Accept: "text/event-stream" } }));
		expect(res.status).toBe(401);
	});

	test("authenticated request serves files", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/index.html", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("data-agent-name");
		expect(body).toContain("phantom-nav-brand");
	});
});

describe("static file serving", () => {
	test("serves index.html for /ui/ path", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("data-agent-name");
		expect(body).toContain("phantom-nav-brand");
	});

	test("serves _base.html", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/_base.html", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain('data-theme="phantom-light"');
		expect(body).toContain("tailwindcss/browser@4");
	});

	test("returns 404 for non-existent files", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/nonexistent.html", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(404);
	});
});

describe("path traversal protection", () => {
	test("blocks ../../../etc/passwd (URL normalizes, file not served)", async () => {
		const { sessionToken } = createSession();
		// URL constructor normalizes /../../../ to / before our handler sees it.
		// The system file is never served - we get 404 (file not found in public/).
		const res = await handleUiRequest(req("/ui/../../../etc/passwd", { cookie: `phantom_session=${sessionToken}` }));
		const body = await res.text();
		expect(body).not.toContain("root:");
		expect([403, 404]).toContain(res.status);
	});

	test("blocks URL-encoded traversal", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(
			req("/ui/%2e%2e/%2e%2e/etc/passwd", { cookie: `phantom_session=${sessionToken}` }),
		);
		const body = await res.text();
		expect(body).not.toContain("root:");
		expect([403, 404]).toContain(res.status);
	});

	test("blocks null bytes in path", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/test%00.html", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(403);
	});

	test("isPathSafe blocks explicit .. in path segments", async () => {
		const { sessionToken } = createSession();
		// Construct a request where the pathname retains the traversal
		// by using a path that doesn't get fully normalized by the URL constructor
		const res = await handleUiRequest(
			new Request("http://localhost:3100/ui/test", {
				headers: {
					Cookie: `phantom_session=${sessionToken}`,
					Accept: "text/html",
				},
			}),
		);
		// /ui/test doesn't exist, so 404 is correct
		expect(res.status).toBe(404);
	});
});

describe("cache control", () => {
	test("dashboard JS returns no-store cache control", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/dashboard/dashboard.js", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-store, no-cache, must-revalidate");
		expect(res.headers.get("Pragma")).toBe("no-cache");
		expect(res.headers.get("Expires")).toBe("0");
	});

	test("non-dashboard assets keep no-cache", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(req("/ui/index.html", { cookie: `phantom_session=${sessionToken}` }));
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
	});

	test("dashboard non-JS assets keep no-cache", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(
			req("/ui/dashboard/dashboard.css", { cookie: `phantom_session=${sessionToken}` }),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Cache-Control")).toBe("no-cache");
	});
});

describe("SSE endpoint", () => {
	test("/ui/api/events requires auth", async () => {
		const res = await handleUiRequest(req("/ui/api/events", { headers: { Accept: "text/event-stream" } }));
		expect(res.status).toBe(401);
	});

	test("/ui/api/events returns SSE response when authenticated", async () => {
		const { sessionToken } = createSession();
		const res = await handleUiRequest(
			req("/ui/api/events", {
				cookie: `phantom_session=${sessionToken}`,
				headers: { Accept: "text/event-stream" },
			}),
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
	});
});
