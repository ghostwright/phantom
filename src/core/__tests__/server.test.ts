import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";
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
});
