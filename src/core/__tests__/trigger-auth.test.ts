import { describe, expect, test } from "bun:test";
import { AuthMiddleware } from "../../mcp/auth.ts";
import { hashTokenSync } from "../../mcp/config.ts";
import type { McpConfig } from "../../mcp/types.ts";

/**
 * Tests that /trigger auth logic requires bearer token with operator scope.
 * Closes ghostwright/phantom#9.
 *
 * Tests the AuthMiddleware directly with constructed Request objects
 * to avoid Bun.serve + fetch issues in GitHub Actions CI.
 */
describe("/trigger endpoint auth", () => {
	const adminToken = "test-trigger-admin-token";
	const readToken = "test-trigger-read-token";
	const operatorToken = "test-trigger-operator-token";

	const mcpConfig: McpConfig = {
		tokens: [
			{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
			{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
			{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
		],
		rate_limit: { requests_per_minute: 60, burst: 10 },
	};

	const auth = new AuthMiddleware(mcpConfig);

	function makeRequest(headers: Record<string, string> = {}): Request {
		return new Request("http://localhost/trigger", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ task: "hello" }),
		});
	}

	test("rejects request with no Authorization header", async () => {
		const result = await auth.authenticate(makeRequest());
		expect(result.authenticated).toBe(false);
		if (!result.authenticated) expect(result.error).toContain("Missing");
	});

	test("rejects request with invalid token", async () => {
		const result = await auth.authenticate(makeRequest({ Authorization: "Bearer wrong-token" }));
		expect(result.authenticated).toBe(false);
		if (!result.authenticated) expect(result.error).toContain("Invalid");
	});

	test("rejects read-only token (insufficient scope)", async () => {
		const result = await auth.authenticate(makeRequest({ Authorization: `Bearer ${readToken}` }));
		expect(result.authenticated).toBe(true);
		expect(auth.hasScope(result, "operator")).toBe(false);
	});

	test("accepts operator token", async () => {
		const result = await auth.authenticate(makeRequest({ Authorization: `Bearer ${operatorToken}` }));
		expect(result.authenticated).toBe(true);
		expect(auth.hasScope(result, "operator")).toBe(true);
	});

	test("accepts admin token", async () => {
		const result = await auth.authenticate(makeRequest({ Authorization: `Bearer ${adminToken}` }));
		expect(result.authenticated).toBe(true);
		expect(auth.hasScope(result, "operator")).toBe(true);
		expect(auth.hasScope(result, "admin")).toBe(true);
	});
});
