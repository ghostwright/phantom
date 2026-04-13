import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import YAML from "yaml";

const TEST_DIR = "/tmp/phantom-token-test";

function seedMcpConfig(): void {
	mkdirSync(`${TEST_DIR}/config`, { recursive: true });
	const config = {
		tokens: [{ name: "admin", hash: "sha256:abc123", scopes: ["read", "operator", "admin"] }],
		rate_limit: { requests_per_minute: 60, burst: 10 },
	};
	writeFileSync(`${TEST_DIR}/config/mcp.yaml`, YAML.stringify(config));
}

describe("phantom token", () => {
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;
	const logs: string[] = [];
	const errors: string[] = [];
	let originalCwd: string;

	beforeEach(() => {
		logs.length = 0;
		errors.length = 0;
		logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});

		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
		originalCwd = process.cwd();
		process.chdir(TEST_DIR);
	});

	afterEach(() => {
		logSpy.mockRestore();
		errorSpy.mockRestore();
		process.chdir(originalCwd);
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	test("prints help with no arguments", async () => {
		const { runToken } = await import("../token.ts");
		await runToken([]);
		expect(logs.some((l) => l.includes("phantom token"))).toBe(true);
		expect(logs.some((l) => l.includes("create"))).toBe(true);
		expect(logs.some((l) => l.includes("list"))).toBe(true);
		expect(logs.some((l) => l.includes("revoke"))).toBe(true);
	});

	test("list shows configured tokens", async () => {
		seedMcpConfig();
		const { runToken } = await import("../token.ts");
		await runToken(["list"]);
		expect(logs.some((l) => l.includes("admin"))).toBe(true);
		expect(logs.some((l) => l.includes("abc123"))).toBe(true);
	});

	test("create generates a new token", async () => {
		seedMcpConfig();
		const { runToken } = await import("../token.ts");

		// Mock process.exit for the duplicate check test
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});
		try {
			await runToken(["create", "--client", "claude-code", "--scope", "operator"]);
		} catch {
			// process.exit mock throws
		}
		exitSpy.mockRestore();

		expect(logs.some((l) => l.includes("Token created for 'claude-code'"))).toBe(true);
		expect(logs.some((l) => l.includes("Token (save this"))).toBe(true);
		expect(logs.some((l) => l.includes('"method":"initialize"'))).toBe(true);
		expect(logs.some((l) => l.includes("Mcp-Session-Id"))).toBe(true);

		// Verify the config file was updated
		const raw = readFileSync(`${TEST_DIR}/config/mcp.yaml`, "utf-8");
		const config = YAML.parse(raw);
		expect(config.tokens).toHaveLength(2);
		expect(config.tokens[1].name).toBe("claude-code");
		expect(config.tokens[1].hash).toMatch(/^sha256:/);
		expect(config.tokens[1].scopes).toContain("operator");
		expect(config.tokens[1].scopes).toContain("read");
	});

	test("create rejects duplicate client name", async () => {
		seedMcpConfig();
		const { runToken } = await import("../token.ts");
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});

		try {
			await runToken(["create", "--client", "admin"]);
		} catch {
			// expected
		}

		expect(errors.some((l) => l.includes("already exists"))).toBe(true);
		exitSpy.mockRestore();
	});

	test("revoke removes a token", async () => {
		seedMcpConfig();
		const { runToken } = await import("../token.ts");
		await runToken(["revoke", "--client", "admin"]);

		expect(logs.some((l) => l.includes("revoked"))).toBe(true);

		const raw = readFileSync(`${TEST_DIR}/config/mcp.yaml`, "utf-8");
		const config = YAML.parse(raw);
		expect(config.tokens).toHaveLength(0);
	});

	test("revoke fails for nonexistent client", async () => {
		seedMcpConfig();
		const { runToken } = await import("../token.ts");
		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("exit");
		});

		try {
			await runToken(["revoke", "--client", "nonexistent"]);
		} catch {
			// expected
		}

		expect(errors.some((l) => l.includes("No token found"))).toBe(true);
		exitSpy.mockRestore();
	});
});
