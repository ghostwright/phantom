import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { hashTokenSync } from "../mcp/config.ts";
import type { McpConfig, McpScope } from "../mcp/types.ts";

const MCP_CONFIG_PATH = "config/mcp.yaml";

function loadMcpConfigRaw(): McpConfig {
	if (!existsSync(MCP_CONFIG_PATH)) {
		throw new Error(`MCP config not found at ${MCP_CONFIG_PATH}. Run 'phantom init' first.`);
	}
	const raw = readFileSync(MCP_CONFIG_PATH, "utf-8");
	return YAML.parse(raw) as McpConfig;
}

function saveMcpConfig(config: McpConfig): void {
	writeFileSync(MCP_CONFIG_PATH, YAML.stringify(config), "utf-8");
}

function createToken(): { token: string; hash: string } {
	const token = crypto.randomUUID();
	const hash = hashTokenSync(token);
	return { token, hash };
}

function printInitializeExample(token: string): void {
	const requestBody = JSON.stringify({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-11-25",
			capabilities: {},
			clientInfo: { name: "curl", version: "1.0" },
		},
	});

	console.log("\nUse with an MCP client or initialize with:");
	console.log("  curl -X POST https://your-phantom/mcp \\");
	console.log(`    -H "Authorization: Bearer ${token}" \\`);
	console.log('    -H "Accept: application/json, text/event-stream" \\');
	console.log('    -H "Content-Type: application/json" \\');
	console.log(`    -d '${requestBody}'`);
	console.log("\nThe response will include an Mcp-Session-Id header for follow-up MCP requests.");
}

function runCreate(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			client: { type: "string" },
			scope: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});

	if (values.help || !values.client) {
		console.log("phantom token create - Generate a new MCP auth token\n");
		console.log("Usage: phantom token create --client <name> --scope <scope>\n");
		console.log("Options:");
		console.log("  --client <name>    Client identifier (e.g., claude-code, dashboard)");
		console.log("  --scope <scope>    Permission scope: read, operator, admin (default: operator)");
		console.log("  -h, --help         Show this help");
		return;
	}

	const scopeStr = values.scope ?? "operator";
	const validScopes = ["read", "operator", "admin"];
	if (!validScopes.includes(scopeStr)) {
		console.error(`Invalid scope '${scopeStr}'. Must be one of: ${validScopes.join(", ")}`);
		process.exit(1);
	}

	const scopes: McpScope[] =
		scopeStr === "admin" ? ["read", "operator", "admin"] : scopeStr === "operator" ? ["read", "operator"] : ["read"];

	const config = loadMcpConfigRaw();
	const existing = config.tokens.find((t) => t.name === values.client);
	if (existing) {
		console.error(
			`Token for client '${values.client}' already exists. Revoke it first with 'phantom token revoke --client ${values.client}'.`,
		);
		process.exit(1);
	}

	const { token, hash } = createToken();
	config.tokens.push({ name: values.client, hash, scopes });
	saveMcpConfig(config);

	console.log(`Token created for '${values.client}' with scope '${scopeStr}'`);
	console.log(`\nToken (save this, it will not be shown again):\n  ${token}`);
	printInitializeExample(token);
}

function runList(): void {
	const config = loadMcpConfigRaw();

	if (config.tokens.length === 0) {
		console.log("No tokens configured.");
		return;
	}

	console.log("MCP Tokens:\n");
	console.log(`${"  Name".padEnd(22)}${"Scopes".padEnd(28)}Hash (first 16)`);
	console.log(`  ${"-".repeat(60)}`);

	for (const token of config.tokens) {
		const hashPreview = `${token.hash.replace("sha256:", "").slice(0, 16)}...`;
		console.log(`  ${token.name.padEnd(20)} ${token.scopes.join(", ").padEnd(26)} ${hashPreview}`);
	}
}

function runRevoke(args: string[]): void {
	const { values } = parseArgs({
		args,
		options: {
			client: { type: "string" },
			help: { type: "boolean", short: "h" },
		},
		allowPositionals: false,
	});

	if (values.help || !values.client) {
		console.log("phantom token revoke - Revoke an MCP auth token\n");
		console.log("Usage: phantom token revoke --client <name>\n");
		console.log("Options:");
		console.log("  --client <name>    Client identifier to revoke");
		console.log("  -h, --help         Show this help");
		return;
	}

	const config = loadMcpConfigRaw();
	const index = config.tokens.findIndex((t) => t.name === values.client);
	if (index === -1) {
		console.error(`No token found for client '${values.client}'.`);
		process.exit(1);
	}

	config.tokens.splice(index, 1);
	saveMcpConfig(config);
	console.log(`Token for '${values.client}' revoked.`);
}

export async function runToken(args: string[]): Promise<void> {
	const subcommand = args[0];
	const subArgs = args.slice(1);

	if (!subcommand || subcommand === "--help" || subcommand === "-h") {
		console.log("phantom token - Manage MCP authentication tokens\n");
		console.log("Usage: phantom token <subcommand> [options]\n");
		console.log("Subcommands:");
		console.log("  create    Generate a new MCP auth token");
		console.log("  list      Show all configured tokens");
		console.log("  revoke    Revoke an existing token");
		return;
	}

	switch (subcommand) {
		case "create":
			runCreate(subArgs);
			break;
		case "list":
			runList();
			break;
		case "revoke":
			runRevoke(subArgs);
			break;
		default:
			console.error(`Unknown subcommand: ${subcommand}`);
			console.error("Run 'phantom token --help' for available subcommands.");
			process.exit(1);
	}
}
