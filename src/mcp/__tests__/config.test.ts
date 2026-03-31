import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { hashTokenSync, loadMcpConfig } from "../config.ts";

describe("MCP Config", () => {
	const tmpDir = join(import.meta.dir, "tmp-config-test");
	const configPath = join(tmpDir, "mcp.yaml");

	beforeAll(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
		mkdirSync(tmpDir, { recursive: true });
	});

	afterAll(() => {
		if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
	});

	test("generates default config when file does not exist", () => {
		const freshPath = join(tmpDir, "fresh-mcp.yaml");
		const config = loadMcpConfig(freshPath);

		expect(config.tokens.length).toBe(2);
		expect(config.tokens[0].name).toBe("admin");
		expect(config.tokens[0].scopes).toContain("admin");
		expect(config.tokens[1].name).toBe("read-only");
		expect(config.tokens[1].scopes).toEqual(["read"]);
		expect(config.rate_limit.requests_per_minute).toBe(60);
		expect(existsSync(freshPath)).toBe(true);
	});

	test("generateDefaultConfig does not log raw tokens to stdout", () => {
		const noTokenPath = join(tmpDir, "no-token-log.yaml");
		const logs: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		};
		try {
			loadMcpConfig(noTokenPath);
		} finally {
			console.log = origLog;
		}

		// Verify config was created with valid tokens
		expect(existsSync(noTokenPath)).toBe(true);
		const config = loadMcpConfig(noTokenPath);
		expect(config.tokens.length).toBe(2);

		// Verify no raw token values appear in stdout
		const allLogs = logs.join("\n");
		// The old log format included "Admin token" and "Read-only token:" with raw values
		expect(allLogs).not.toContain("Admin token");
		expect(allLogs).not.toContain("Read-only token:");
		// The redacted message should appear instead
		expect(allLogs).toContain("Tokens written to config");
	});

	test("loads existing config", () => {
		const testConfig = {
			tokens: [{ name: "test-client", hash: "sha256:abc123", scopes: ["read", "operator"] }],
			rate_limit: { requests_per_minute: 100, burst: 20 },
		};

		writeFileSync(configPath, YAML.stringify(testConfig));

		const loaded = loadMcpConfig(configPath);
		expect(loaded.tokens.length).toBe(1);
		expect(loaded.tokens[0].name).toBe("test-client");
		expect(loaded.rate_limit.requests_per_minute).toBe(100);
	});

	test("hashTokenSync produces consistent hashes", () => {
		const token = "my-secret-token";
		const hash1 = hashTokenSync(token);
		const hash2 = hashTokenSync(token);
		expect(hash1).toBe(hash2);
		expect(hash1).toStartWith("sha256:");
		expect(hash1.length).toBe(71); // "sha256:" (7) + 64 hex chars
	});

	test("different tokens produce different hashes", () => {
		const hash1 = hashTokenSync("token-a");
		const hash2 = hashTokenSync("token-b");
		expect(hash1).not.toBe(hash2);
	});

	test("defaults are applied for missing fields", () => {
		const minimalConfig = {
			tokens: [{ name: "min", hash: "sha256:abc", scopes: ["read"] }],
		};
		writeFileSync(configPath, YAML.stringify(minimalConfig));

		const loaded = loadMcpConfig(configPath);
		expect(loaded.rate_limit.requests_per_minute).toBe(60);
		expect(loaded.rate_limit.burst).toBe(10);
	});
});
