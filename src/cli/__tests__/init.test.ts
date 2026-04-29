import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import YAML from "yaml";

// Use a temp directory to avoid clobbering real config
const TEST_DIR = "/tmp/phantom-init-test";

describe("phantom init", () => {
	let logSpy: ReturnType<typeof spyOn>;
	let errorSpy: ReturnType<typeof spyOn>;
	const logs: string[] = [];
	let originalCwd: string;

	beforeEach(() => {
		logs.length = 0;
		logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});
		errorSpy = spyOn(console, "error").mockImplementation(() => {});

		// Clean and create test directory
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

	test("prints help with --help", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--help"]);
		expect(logs.some((l) => l.includes("phantom init"))).toBe(true);
		expect(logs.some((l) => l.includes("--name"))).toBe(true);
		expect(logs.some((l) => l.includes("--role"))).toBe(true);
	});

	test("creates config files with --yes defaults", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		expect(existsSync("config/phantom.yaml")).toBe(true);
		expect(existsSync("config/mcp.yaml")).toBe(true);
		expect(existsSync("config/channels.yaml")).toBe(true);
		expect(existsSync("phantom-config/constitution.md")).toBe(true);
		expect(existsSync("phantom-config/persona.md")).toBe(true);
		expect(existsSync("phantom-config/domain-knowledge.md")).toBe(true);
		expect(existsSync("phantom-config/strategies/task-patterns.md")).toBe(true);
	});

	test("phantom.yaml has correct defaults", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.name).toBe("phantom");
		expect(config.role).toBe("swe");
		expect(config.port).toBe(3100);
		expect(config.model).toBe("claude-opus-4-7");
	});

	test("accepts custom name and role", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes", "--name", "scout", "--role", "base"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.name).toBe("scout");
		expect(config.role).toBe("base");
	});

	test("mcp.yaml has valid tokens", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/mcp.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.tokens).toHaveLength(3);
		expect(config.tokens[0].name).toBe("admin");
		expect(config.tokens[0].hash).toMatch(/^sha256:/);
		expect(config.tokens[0].scopes).toContain("admin");
	});

	test("prints MCP tokens", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		expect(logs.some((l) => l.includes("Admin:"))).toBe(true);
		expect(logs.some((l) => l.includes("Operator:"))).toBe(true);
		expect(logs.some((l) => l.includes("Read:"))).toBe(true);
	});

	test("refuses to reinitialize if config exists", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);
		logs.length = 0;
		await runInit(["--yes"]);

		expect(logs.some((l) => l.includes("already initialized"))).toBe(true);
	});

	test("channels.yaml has env var placeholders", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/channels.yaml", "utf-8");
		expect(raw).toContain("${SLACK_BOT_TOKEN}");
		expect(raw).toContain("${SLACK_APP_TOKEN}");
	});

	test("channels.yaml with --yes has slack disabled and default_user_id comment", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/channels.yaml", "utf-8");
		expect(raw).toContain("enabled: false");
		expect(raw).toContain("# default_channel_id:");
		expect(raw).toContain("# default_user_id:");
	});

	test("does not create .env.local with --yes (no Slack tokens)", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		expect(existsSync(".env.local")).toBe(false);
	});
});

describe("phantom init --yes (environment-aware)", () => {
	let logSpy: ReturnType<typeof spyOn>;
	const logs: string[] = [];
	let originalCwd: string;
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"PHANTOM_NAME",
		"AGENT_NAME",
		"PHANTOM_ROLE",
		"AGENT_ROLE",
		"PORT",
		"PHANTOM_MODEL",
		"PHANTOM_DOMAIN",
		"PHANTOM_EFFORT",
		"SLACK_BOT_TOKEN",
		"SLACK_APP_TOKEN",
		"SLACK_CHANNEL_ID",
		"SLACK_USER_ID",
		"OWNER_SLACK_USER_ID",
	];

	beforeEach(() => {
		logs.length = 0;
		logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		});

		// Save and clear env vars
		for (const key of envKeys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}

		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
		mkdirSync(TEST_DIR, { recursive: true });
		originalCwd = process.cwd();
		process.chdir(TEST_DIR);
	});

	afterEach(() => {
		logSpy.mockRestore();
		// Restore env vars
		for (const key of envKeys) {
			if (savedEnv[key] !== undefined) {
				process.env[key] = savedEnv[key];
			} else {
				delete process.env[key];
			}
		}
		process.chdir(originalCwd);
		if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
	});

	test("reads PHANTOM_NAME from environment", async () => {
		process.env.PHANTOM_NAME = "scout";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.name).toBe("scout");
	});

	test("reads AGENT_NAME as fallback", async () => {
		process.env.AGENT_NAME = "analyst";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.name).toBe("analyst");
	});

	test("PHANTOM_NAME takes precedence over AGENT_NAME", async () => {
		process.env.PHANTOM_NAME = "scout";
		process.env.AGENT_NAME = "analyst";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.name).toBe("scout");
	});

	test("reads PHANTOM_ROLE from environment", async () => {
		process.env.PHANTOM_ROLE = "base";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.role).toBe("base");
	});

	test("reads PORT from environment", async () => {
		process.env.PORT = "8080";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.port).toBe(8080);
	});

	test("auto-configures Slack from env vars", async () => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
		process.env.SLACK_APP_TOKEN = "xapp-test-token";
		process.env.SLACK_CHANNEL_ID = "C04TEST123";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/channels.yaml", "utf-8");
		expect(raw).toContain("enabled: true");
		expect(raw).toContain("default_channel_id: C04TEST123");
	});

	test("does not write .env.local when Slack tokens come from environment", async () => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
		process.env.SLACK_APP_TOKEN = "xapp-test-token";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		expect(existsSync(".env.local")).toBe(false);
	});

	test("sets default_user_id when SLACK_USER_ID is set but no channel", async () => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
		process.env.SLACK_APP_TOKEN = "xapp-test-token";
		process.env.SLACK_USER_ID = "U04TESTUSER";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/channels.yaml", "utf-8");
		expect(raw).toContain("default_user_id: U04TESTUSER");
	});

	test("CLI flags override environment vars", async () => {
		process.env.PHANTOM_NAME = "from-env";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes", "--name", "from-cli"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.name).toBe("from-cli");
	});

	test("sets owner_user_id when OWNER_SLACK_USER_ID is set", async () => {
		process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
		process.env.SLACK_APP_TOKEN = "xapp-test-token";
		process.env.OWNER_SLACK_USER_ID = "U04OWNER123";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/channels.yaml", "utf-8");
		expect(raw).toContain("owner_user_id: U04OWNER123");
	});

	test("channels.yaml has owner_user_id comment when disabled", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/channels.yaml", "utf-8");
		expect(raw).toContain("# owner_user_id:");
	});

	test("reads PHANTOM_MODEL from environment", async () => {
		process.env.PHANTOM_MODEL = "claude-opus-4-6";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.model).toBe("claude-opus-4-6");
	});

	test("defaults model to claude-opus-4-7", async () => {
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.model).toBe("claude-opus-4-7");
	});

	test("reads PHANTOM_DOMAIN from environment", async () => {
		process.env.PHANTOM_DOMAIN = "ghostwright.dev";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.domain).toBe("ghostwright.dev");
	});

	test("reads PHANTOM_EFFORT from environment", async () => {
		process.env.PHANTOM_EFFORT = "high";
		const { runInit } = await import("../init.ts");
		await runInit(["--yes"]);

		const raw = readFileSync("config/phantom.yaml", "utf-8");
		const config = YAML.parse(raw);
		expect(config.effort).toBe("high");
	});
});
