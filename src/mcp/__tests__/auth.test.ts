import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { AuthMiddleware } from "../auth.ts";
import { hashTokenSync } from "../config.ts";
import type { McpConfig, McpScope } from "../types.ts";

describe("AuthMiddleware", () => {
	const adminToken = "test-admin-token-1234";
	const readToken = "test-read-token-5678";
	const operatorToken = "test-operator-token-9012";

	const config: McpConfig = {
		tokens: [
			{ name: "admin", hash: hashTokenSync(adminToken), scopes: ["read", "operator", "admin"] },
			{ name: "reader", hash: hashTokenSync(readToken), scopes: ["read"] },
			{ name: "operator", hash: hashTokenSync(operatorToken), scopes: ["read", "operator"] },
		],
		rate_limit: { requests_per_minute: 60, burst: 10 },
	};

	let auth: AuthMiddleware;

	beforeAll(() => {
		auth = new AuthMiddleware(config);
	});

	test("authenticates valid admin token", async () => {
		const req = new Request("http://localhost/mcp", {
			headers: { Authorization: `Bearer ${adminToken}` },
		});
		const result = await auth.authenticate(req);
		expect(result.authenticated).toBe(true);
		if (result.authenticated) {
			expect(result.clientName).toBe("admin");
			expect(result.scopes).toContain("admin");
		}
	});

	test("authenticates valid read token", async () => {
		const req = new Request("http://localhost/mcp", {
			headers: { Authorization: `Bearer ${readToken}` },
		});
		const result = await auth.authenticate(req);
		expect(result.authenticated).toBe(true);
		if (result.authenticated) {
			expect(result.clientName).toBe("reader");
			expect(result.scopes).toEqual(["read"]);
		}
	});

	test("rejects missing Authorization header", async () => {
		const req = new Request("http://localhost/mcp");
		const result = await auth.authenticate(req);
		expect(result.authenticated).toBe(false);
		if (!result.authenticated) {
			expect(result.error).toContain("Missing");
		}
	});

	test("rejects non-Bearer auth", async () => {
		const req = new Request("http://localhost/mcp", {
			headers: { Authorization: "Basic dXNlcjpwYXNz" },
		});
		const result = await auth.authenticate(req);
		expect(result.authenticated).toBe(false);
	});

	test("rejects invalid token", async () => {
		const req = new Request("http://localhost/mcp", {
			headers: { Authorization: "Bearer completely-wrong-token" },
		});
		const result = await auth.authenticate(req);
		expect(result.authenticated).toBe(false);
		if (!result.authenticated) {
			expect(result.error).toContain("Invalid");
		}
	});

	test("rejects empty bearer token", async () => {
		const req = new Request("http://localhost/mcp", {
			headers: { Authorization: "Bearer " },
		});
		const result = await auth.authenticate(req);
		expect(result.authenticated).toBe(false);
	});

	test("hasScope: admin scope grants all", () => {
		const adminAuth = { authenticated: true as const, clientName: "admin", scopes: ["admin" as McpScope] };
		expect(auth.hasScope(adminAuth, "read")).toBe(true);
		expect(auth.hasScope(adminAuth, "operator")).toBe(true);
		expect(auth.hasScope(adminAuth, "admin")).toBe(true);
	});

	test("hasScope: read scope only grants read", () => {
		const readAuth = { authenticated: true as const, clientName: "reader", scopes: ["read" as McpScope] };
		expect(auth.hasScope(readAuth, "read")).toBe(true);
		expect(auth.hasScope(readAuth, "operator")).toBe(false);
		expect(auth.hasScope(readAuth, "admin")).toBe(false);
	});

	test("hasScope: operator implies read", () => {
		const opAuth = { authenticated: true as const, clientName: "op", scopes: ["operator" as McpScope] };
		expect(auth.hasScope(opAuth, "read")).toBe(true);
		expect(auth.hasScope(opAuth, "operator")).toBe(true);
		expect(auth.hasScope(opAuth, "admin")).toBe(false);
	});

	test("hasScope: unauthenticated has no scopes", () => {
		const noAuth = { authenticated: false as const, error: "nope" };
		expect(auth.hasScope(noAuth, "read")).toBe(false);
	});

	test("reloads file-backed tokens when config changes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "phantom-auth-test-"));
		const configPath = join(tempDir, "mcp.yaml");
		const alphaToken = "alpha-token";
		const betaToken = "beta-token";

		const writeConfig = (tokens: McpConfig["tokens"]) => {
			writeFileSync(
				configPath,
				YAML.stringify({ tokens, rate_limit: { requests_per_minute: 60, burst: 10 } }),
				"utf-8",
			);
		};

		try {
			writeConfig([{ name: "alpha", hash: hashTokenSync(alphaToken), scopes: ["read"] }]);
			const fileAuth = new AuthMiddleware(configPath);

			const before = await fileAuth.authenticate(
				new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${betaToken}` } }),
			);
			expect(before.authenticated).toBe(false);

			writeConfig([{ name: "beta", hash: hashTokenSync(betaToken), scopes: ["read", "operator"] }]);

			const after = await fileAuth.authenticate(
				new Request("http://localhost/mcp", { headers: { Authorization: `Bearer ${betaToken}` } }),
			);
			expect(after.authenticated).toBe(true);
			if (after.authenticated) {
				expect(after.clientName).toBe("beta");
				expect(after.scopes).toContain("operator");
			}
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
