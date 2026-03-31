import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { McpConfig } from "./types.ts";

const McpConfigSchema = z.object({
	tokens: z
		.array(
			z.object({
				name: z.string().min(1),
				hash: z.string().min(1),
				scopes: z.array(z.enum(["read", "operator", "admin"])).min(1),
			}),
		)
		.default([]),
	rate_limit: z
		.object({
			requests_per_minute: z.number().int().positive().default(60),
			burst: z.number().int().positive().default(10),
		})
		.default({}),
});

export function loadMcpConfig(path = "config/mcp.yaml"): McpConfig {
	if (!existsSync(path)) {
		return generateDefaultConfig(path);
	}

	const raw = readFileSync(path, "utf-8");
	const parsed = YAML.parse(raw);
	return McpConfigSchema.parse(parsed);
}

async function hashToken(token: string): Promise<string> {
	const encoded = new TextEncoder().encode(token);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}

function generateDefaultConfig(path: string): McpConfig {
	const adminToken = crypto.randomUUID();
	const readToken = crypto.randomUUID();

	// Hash tokens synchronously using Bun's crypto
	const adminHash = hashTokenSync(adminToken);
	const readHash = hashTokenSync(readToken);

	const config: McpConfig = {
		tokens: [
			{ name: "admin", hash: adminHash, scopes: ["read", "operator", "admin"] },
			{ name: "read-only", hash: readHash, scopes: ["read"] },
		],
		rate_limit: {
			requests_per_minute: 60,
			burst: 10,
		},
	};

	const dir = dirname(path);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}

	const yamlContent = YAML.stringify(config);
	writeFileSync(path, yamlContent, "utf-8");

	console.log("[mcp] Generated default MCP config at", path);
	console.log("[mcp] Tokens written to config. Run 'phantom token list' to manage tokens.");

	return config;
}

function hashTokenSync(token: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(token);
	return `sha256:${hasher.digest("hex")}`;
}

export { hashToken, hashTokenSync };
