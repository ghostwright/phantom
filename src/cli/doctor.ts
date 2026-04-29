import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

type CheckResult = {
	name: string;
	status: "ok" | "warn" | "fail";
	message: string;
	fix?: string;
};

async function checkBun(): Promise<CheckResult> {
	try {
		const version = Bun.version;
		const major = Number.parseInt(version.split(".")[0], 10);
		if (major < 1) {
			return {
				name: "Bun",
				status: "warn",
				message: `Bun ${version} (recommend 1.x+)`,
				fix: "curl -fsSL https://bun.sh/install | bash",
			};
		}
		return { name: "Bun", status: "ok", message: `v${version}` };
	} catch {
		return { name: "Bun", status: "fail", message: "Not found", fix: "curl -fsSL https://bun.sh/install | bash" };
	}
}

async function checkDocker(): Promise<CheckResult> {
	try {
		const proc = Bun.spawn(["docker", "info"], { stdout: "pipe", stderr: "pipe" });
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return { name: "Docker", status: "fail", message: "Not running", fix: "sudo systemctl start docker" };
		}
		return { name: "Docker", status: "ok", message: "Running" };
	} catch {
		return { name: "Docker", status: "fail", message: "Not installed", fix: "https://docs.docker.com/engine/install/" };
	}
}

async function checkQdrant(): Promise<CheckResult> {
	try {
		const resp = await fetch("http://localhost:6333/healthz", { signal: AbortSignal.timeout(3000) });
		if (resp.ok) {
			return { name: "Qdrant", status: "ok", message: "Healthy (port 6333)" };
		}
		return { name: "Qdrant", status: "fail", message: `HTTP ${resp.status}`, fix: "docker compose up -d qdrant" };
	} catch {
		return {
			name: "Qdrant",
			status: "fail",
			message: "Not reachable at localhost:6333",
			fix: "docker compose up -d qdrant",
		};
	}
}

async function checkOllama(): Promise<CheckResult> {
	try {
		const resp = await fetch("http://localhost:11434/api/tags", { signal: AbortSignal.timeout(3000) });
		if (!resp.ok) {
			return { name: "Ollama", status: "fail", message: `HTTP ${resp.status}`, fix: "docker compose up -d ollama" };
		}
		const data = (await resp.json()) as { models?: Array<{ name: string }> };
		const models = data.models ?? [];
		const hasEmbed = models.some((m) => m.name.includes("nomic-embed-text"));
		if (!hasEmbed) {
			return {
				name: "Ollama",
				status: "warn",
				message: "Running but nomic-embed-text model not pulled",
				fix: "docker exec phantom-ollama ollama pull nomic-embed-text",
			};
		}
		return { name: "Ollama", status: "ok", message: `Healthy, ${models.length} model(s) loaded` };
	} catch {
		return {
			name: "Ollama",
			status: "fail",
			message: "Not reachable at localhost:11434",
			fix: "docker compose up -d ollama",
		};
	}
}

async function checkConfig(): Promise<CheckResult> {
	if (!existsSync("config/phantom.yaml")) {
		return { name: "Config", status: "fail", message: "config/phantom.yaml not found", fix: "phantom init" };
	}
	try {
		const { loadConfig } = await import("../config/loader.ts");
		const config = await loadConfig();
		return { name: "Config", status: "ok", message: `${config.name} (${config.role}, port ${config.port})` };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { name: "Config", status: "fail", message: msg, fix: "Fix config/phantom.yaml or run phantom init" };
	}
}

async function checkMcpConfig(): Promise<CheckResult> {
	if (!existsSync("config/mcp.yaml")) {
		return {
			name: "MCP Config",
			status: "warn",
			message: "config/mcp.yaml not found (will be auto-generated)",
			fix: "phantom init",
		};
	}
	try {
		const raw = readFileSync("config/mcp.yaml", "utf-8");
		if (raw.includes("placeholder-generate-on-first-run")) {
			return {
				name: "MCP Config",
				status: "warn",
				message: "Contains placeholder tokens",
				fix: "phantom init (or phantom token create)",
			};
		}
		return { name: "MCP Config", status: "ok", message: "Tokens configured" };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { name: "MCP Config", status: "fail", message: msg };
	}
}

async function checkDatabase(): Promise<CheckResult> {
	try {
		const { getDatabase } = await import("../db/connection.ts");
		const db = getDatabase();
		const result = db.query("SELECT COUNT(*) as count FROM sessions").get() as { count: number } | null;
		const count = result?.count ?? 0;
		return { name: "SQLite", status: "ok", message: `data/phantom.db (${count} sessions)` };
	} catch {
		return { name: "SQLite", status: "ok", message: "No database yet (will be created on first run)" };
	}
}

async function checkEvolvedConfig(): Promise<CheckResult> {
	if (!existsSync("phantom-config")) {
		return { name: "Evolved Config", status: "warn", message: "phantom-config/ not found", fix: "phantom init" };
	}
	const requiredFiles = ["constitution.md", "persona.md", "domain-knowledge.md"];
	const missing = requiredFiles.filter((f) => !existsSync(`phantom-config/${f}`));
	if (missing.length > 0) {
		return { name: "Evolved Config", status: "warn", message: `Missing: ${missing.join(", ")}`, fix: "phantom init" };
	}
	return { name: "Evolved Config", status: "ok", message: "All config files present" };
}

async function checkPhantomHealth(port: number): Promise<CheckResult> {
	try {
		const resp = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(3000) });
		if (!resp.ok) {
			return { name: "Phantom Process", status: "fail", message: `HTTP ${resp.status} on port ${port}` };
		}
		const data = (await resp.json()) as { status: string; agent: string; version: string; uptime: number };
		const uptimeMin = Math.floor(data.uptime / 60);
		return { name: "Phantom Process", status: "ok", message: `${data.agent} v${data.version} (up ${uptimeMin}m)` };
	} catch {
		return { name: "Phantom Process", status: "warn", message: `Not running on port ${port}`, fix: "phantom start" };
	}
}

export async function runDoctor(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			json: { type: "boolean" },
			port: { type: "string", short: "p" },
		},
		allowPositionals: false,
	});

	if (values.help) {
		console.log("phantom doctor - Check system health and diagnose issues\n");
		console.log("Usage: phantom doctor [options]\n");
		console.log("Options:");
		console.log("  --json             Output results as JSON");
		console.log("  -p, --port <port>  Port to check for running Phantom (default: 3100)");
		console.log("  -h, --help         Show this help");
		return;
	}

	const port = values.port ? Number.parseInt(values.port, 10) : 3100;

	const checks = await Promise.all([
		checkBun(),
		checkDocker(),
		checkQdrant(),
		checkOllama(),
		checkConfig(),
		checkMcpConfig(),
		checkDatabase(),
		checkEvolvedConfig(),
		checkPhantomHealth(port),
	]);

	if (values.json) {
		console.log(JSON.stringify(checks, null, 2));
		return;
	}

	console.log("Phantom Doctor\n");

	const statusIcon: Record<string, string> = {
		ok: "  OK",
		warn: "WARN",
		fail: "FAIL",
	};

	for (const check of checks) {
		const icon = statusIcon[check.status];
		console.log(`  [${icon}] ${check.name}: ${check.message}`);
		if (check.fix && check.status !== "ok") {
			console.log(`         Fix: ${check.fix}`);
		}
	}

	const failCount = checks.filter((c) => c.status === "fail").length;
	const warnCount = checks.filter((c) => c.status === "warn").length;

	console.log("");
	if (failCount === 0 && warnCount === 0) {
		console.log("All checks passed.");
	} else if (failCount === 0) {
		console.log(`${warnCount} warning(s). Phantom can run but some features may be limited.`);
	} else {
		console.log(`${failCount} failure(s), ${warnCount} warning(s). Fix failures before starting Phantom.`);
	}
}
