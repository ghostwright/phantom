import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";
import { handleUiRequest, setPublicDir } from "../../ui/serve.ts";
import { startServer } from "../server.ts";

/**
 * End-to-end routing tests: bare-root redirect and /health content negotiation.
 * A real Bun.serve instance is started on an ephemeral port so we exercise the
 * same fetch pipeline production traffic sees.
 */
describe("server routing", () => {
	const mcpConfigPath = "config/mcp.yaml";
	let originalMcpYaml: string | null = null;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		if (existsSync(mcpConfigPath)) {
			originalMcpYaml = readFileSync(mcpConfigPath, "utf-8");
		}
		const mcpConfig: McpConfig = {
			tokens: [{ name: "admin", hash: hashTokenSync("test-admin"), scopes: ["read", "operator", "admin"] }],
			rate_limit: { requests_per_minute: 60, burst: 10 },
		};
		mkdirSync("config", { recursive: true });
		writeFileSync(mcpConfigPath, YAML.stringify(mcpConfig), "utf-8");

		server = startServer({ name: "phantom", port: 0, role: "base" } as never, Date.now());
		baseUrl = `http://localhost:${server.port}`;
	});

	afterAll(() => {
		server?.stop(true);
		if (originalMcpYaml !== null) {
			writeFileSync(mcpConfigPath, originalMcpYaml, "utf-8");
		}
	});

	describe("GET /", () => {
		test("redirects to /ui/ with 302", async () => {
			const res = await fetch(`${baseUrl}/`, { redirect: "manual" });
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).toBe("/ui/");
		});
	});

	describe("GET /health", () => {
		test("no Accept header returns JSON", async () => {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("application/json");
			const body = (await res.json()) as { agent: string; status: string };
			expect(body.agent).toBe("phantom");
			expect(body.status).toBe("ok");
		});

		test("Accept: application/json returns JSON", async () => {
			const res = await fetch(`${baseUrl}/health`, { headers: { Accept: "application/json" } });
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("application/json");
			const body = (await res.json()) as { agent: string };
			expect(body.agent).toBe("phantom");
		});

		test("Accept: text/html returns the HTML page", async () => {
			const res = await fetch(`${baseUrl}/health`, { headers: { Accept: "text/html" } });
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/html");
			const body = await res.text();
			expect(body).toContain("<!DOCTYPE html");
			expect(body).toContain("phantom");
			expect(body).toContain("phantom-nav-brand");
		});

		test("browser-style Accept returns the HTML page", async () => {
			const res = await fetch(`${baseUrl}/health`, {
				headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("text/html");
			const body = await res.text();
			expect(body).toContain("<!DOCTYPE html");
		});

		test("?format=json overrides HTML Accept", async () => {
			const res = await fetch(`${baseUrl}/health?format=json`, { headers: { Accept: "text/html" } });
			expect(res.status).toBe(200);
			expect(res.headers.get("Content-Type")).toContain("application/json");
			const body = (await res.json()) as { agent: string };
			expect(body.agent).toBe("phantom");
		});
	});

	// /public/* is the agent publishing surface: files under public/public/*
	// on disk are served without auth so Googlebot and unauthenticated
	// visitors can fetch them. These tests redirect publicDir at a tmp dir
	// so they never mutate the repo's own public/ tree.
	describe("GET /public/*", () => {
		const realPublic = resolve(import.meta.dir, "../../../public");
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "phantom-public-"));
			setPublicDir(tmpDir);
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
			setPublicDir(realPublic);
		});

		function write(rel: string, content: string): void {
			const full = join(tmpDir, rel);
			mkdirSync(full.substring(0, full.lastIndexOf("/")), { recursive: true });
			writeFileSync(full, content, "utf-8");
		}

		test("GET /public/ serves public/public/index.html when present, no redirect to /ui/login", async () => {
			write("public/index.html", "<!doctype html><title>Blog</title>");
			const res = await fetch(`${baseUrl}/public/`, { redirect: "manual" });
			expect(res.status).toBe(200);
			expect(res.headers.get("Location")).toBeNull();
			const body = await res.text();
			expect(body).toContain("Blog");
		});

		test("GET /public/ returns 404 when index.html is missing, never 302", async () => {
			const res = await fetch(`${baseUrl}/public/`, { redirect: "manual" });
			expect(res.status).toBe(404);
			expect(res.headers.get("Location")).toBeNull();
		});

		test("GET /public/blog/foo.html serves without cookie", async () => {
			write("public/blog/foo.html", "<!doctype html><title>Post</title>");
			const res = await fetch(`${baseUrl}/public/blog/foo.html`);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Post");
		});

		test("GET /public/blog/ falls back to index.html inside the directory", async () => {
			write("public/blog/index.html", "<!doctype html><title>Blog Index</title>");
			const res = await fetch(`${baseUrl}/public/blog/`);
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Blog Index");
		});

		test("traversal attempt /public/..%2Fsecret.html returns 403", async () => {
			write("secret.html", "<!doctype html><title>secret</title>");
			const res = await fetch(`${baseUrl}/public/..%2Fsecret.html`);
			expect(res.status).toBe(403);
			const body = await res.text();
			expect(body).not.toContain("secret");
		});

		test("traversal to dashboard.js via /public/../dashboard/dashboard.js returns 403", async () => {
			write("dashboard/dashboard.js", "console.log('priv');");
			const res = await fetch(`${baseUrl}/public/..%2Fdashboard%2Fdashboard.js`);
			expect(res.status).toBe(403);
			const body = await res.text();
			expect(body).not.toContain("console.log");
		});

		test("Cache-Control on /public/* responses is public, max-age=300", async () => {
			write("public/post.html", "<!doctype html><title>Post</title>");
			const res = await fetch(`${baseUrl}/public/post.html`);
			expect(res.status).toBe(200);
			expect(res.headers.get("Cache-Control")).toBe("public, max-age=300");
		});

		test("regression: GET /ui/foo.html without cookie still redirects to /ui/login", async () => {
			write("foo.html", "<!doctype html><title>Private</title>");
			const res = await handleUiRequest(
				new Request("http://localhost/ui/foo.html", { headers: { Accept: "text/html" } }),
			);
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).toBe("/ui/login");
		});

		test("regression: GET /ui/dashboard/dashboard.js without cookie still returns 401", async () => {
			write("dashboard/dashboard.js", "console.log('priv');");
			const res = await handleUiRequest(
				new Request("http://localhost/ui/dashboard/dashboard.js", { headers: { Accept: "application/javascript" } }),
			);
			expect(res.status).toBe(401);
		});
	});
});
