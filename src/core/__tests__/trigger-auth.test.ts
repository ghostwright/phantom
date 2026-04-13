import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";
import { setTriggerDeps, startServer } from "../server.ts";

/**
 * Tests that the /trigger endpoint requires bearer token auth
 * with operator scope. Closes ghostwright/phantom#9.
 */
describe("/trigger endpoint auth", () => {
	const adminToken = "test-trigger-admin-token";
	const readToken = "test-trigger-read-token";
	const operatorToken = "test-trigger-operator-token";
	const lateOperatorToken = "test-trigger-operator-late";

	let testDir: string;
	let mcpConfigPath: string;
	let server: ReturnType<typeof Bun.serve>;
	let baseUrl: string;

	beforeAll(() => {
		testDir = join(import.meta.dir, "tmp-trigger-auth");
		mcpConfigPath = join(testDir, "mcp.yaml");
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });

		// Write test tokens to mcp.yaml so loadMcpConfig picks them up
		const mcpConfig: McpConfig = {
			tokens: [
				{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
				{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
				{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
			],
			rate_limit: { requests_per_minute: 60, burst: 10 },
		};

		mkdirSync(testDir, { recursive: true });
		writeFileSync(mcpConfigPath, YAML.stringify(mcpConfig), "utf-8");

		server = startTestServer(mcpConfigPath);
		baseUrl = `http://localhost:${server.port}`;

		// Wire trigger deps with a mock runtime
		setTriggerDeps({
			runtime: {
				handleMessage: async () => ({
					text: "ok",
					cost: { totalUsd: 0 },
					durationMs: 0,
				}),
			} as never,
		});
	});

	afterAll(() => {
		server?.stop(true);
		if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
	});

	const triggerBody = JSON.stringify({ task: "hello" });

	test("rejects request with no Authorization header", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: triggerBody,
		});
		expect(res.status).toBe(401);
		const json = (await res.json()) as { status: string; message: string };
		expect(json.message).toContain("Missing");
	});

	test("rejects request with invalid token", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: triggerBody,
		});
		expect(res.status).toBe(401);
	});

	test("rejects read-only token (insufficient scope)", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${readToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(403);
		const json = (await res.json()) as { status: string; message: string };
		expect(json.message).toContain("operator");
	});

	test("accepts operator token", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${operatorToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { status: string };
		expect(json.status).toBe("ok");
	});

	test("accepts admin token", async () => {
		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${adminToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(200);
	});

	test("accepts token added after server startup", async () => {
		const updatedConfig: McpConfig = {
			tokens: [
				{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
				{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
				{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
				{ name: "late-operator", hash: hashTokenSync(lateOperatorToken), scopes: ["read", "operator"] },
			],
			rate_limit: { requests_per_minute: 60, burst: 10 },
		};
		writeFileSync(mcpConfigPath, YAML.stringify(updatedConfig), "utf-8");

		const res = await fetch(`${baseUrl}/trigger`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${lateOperatorToken}`,
			},
			body: triggerBody,
		});
		expect(res.status).toBe(200);
	});
});

function startTestServer(mcpConfigPath: string): ReturnType<typeof Bun.serve> {
	let lastError: unknown = null;
	for (let attempt = 0; attempt < 10; attempt++) {
		const port = 40_000 + Math.floor(Math.random() * 20_000);
		try {
			return startServer({ name: "test", port, role: "base" } as never, Date.now(), mcpConfigPath);
		} catch (err: unknown) {
			lastError = err;
		}
	}

	throw lastError instanceof Error ? lastError : new Error("Failed to start test server");
}
