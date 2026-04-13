import { statSync } from "node:fs";
import { loadMcpConfig } from "./config.ts";
import type { AuthResult, McpConfig, McpScope } from "./types.ts";

type TokenEntry = {
	name: string;
	scopes: McpScope[];
};

export class AuthMiddleware {
	private tokenMap: Map<string, TokenEntry>;
	private configPath: string | null;
	private lastConfigFingerprint: string | null;

	constructor(configOrPath: McpConfig | string = "config/mcp.yaml") {
		if (typeof configOrPath === "string") {
			const config = loadMcpConfig(configOrPath);
			this.tokenMap = buildTokenMap(config);
			this.configPath = configOrPath;
			this.lastConfigFingerprint = getConfigFingerprint(configOrPath);
			return;
		}

		this.tokenMap = buildTokenMap(configOrPath);
		this.configPath = null;
		this.lastConfigFingerprint = null;
	}

	async authenticate(req: Request): Promise<AuthResult> {
		this.reloadConfigIfNeeded();

		const authHeader = req.headers.get("Authorization");
		if (!authHeader) {
			return { authenticated: false, error: "Missing Authorization header" };
		}

		if (!authHeader.startsWith("Bearer ")) {
			return { authenticated: false, error: "Authorization must use Bearer scheme" };
		}

		const rawToken = authHeader.slice(7).trim();
		if (!rawToken) {
			return { authenticated: false, error: "Empty bearer token" };
		}

		const hash = await this.hashToken(rawToken);
		const entry = this.tokenMap.get(hash);

		if (!entry) {
			return { authenticated: false, error: "Invalid token" };
		}

		return { authenticated: true, clientName: entry.name, scopes: entry.scopes };
	}

	hasScope(auth: AuthResult, scope: McpScope): boolean {
		if (!auth.authenticated) return false;
		// admin implies all scopes
		if (auth.scopes.includes("admin")) return true;
		// operator implies read
		if (scope === "read" && auth.scopes.includes("operator")) return true;
		return auth.scopes.includes(scope);
	}

	private async hashToken(token: string): Promise<string> {
		const encoded = new TextEncoder().encode(token);
		const digest = await crypto.subtle.digest("SHA-256", encoded);
		const hex = Array.from(new Uint8Array(digest))
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		return `sha256:${hex}`;
	}

	private reloadConfigIfNeeded(): void {
		if (!this.configPath) return;

		const fingerprint = getConfigFingerprint(this.configPath);
		if (!fingerprint || fingerprint === this.lastConfigFingerprint) {
			return;
		}

		try {
			const config = loadMcpConfig(this.configPath);
			this.tokenMap = buildTokenMap(config);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[mcp] Failed to reload auth config from ${this.configPath}: ${msg}`);
		} finally {
			this.lastConfigFingerprint = fingerprint;
		}
	}
}

function buildTokenMap(config: McpConfig): Map<string, TokenEntry> {
	const tokenMap = new Map<string, TokenEntry>();
	for (const token of config.tokens) {
		tokenMap.set(token.hash, { name: token.name, scopes: token.scopes });
	}
	return tokenMap;
}

function getConfigFingerprint(path: string): string | null {
	try {
		const stats = statSync(path);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return null;
	}
}

// Scope requirements for each tool/method
const TOOL_SCOPES: Record<string, McpScope> = {
	phantom_ask: "operator",
	phantom_status: "read",
	phantom_memory_query: "read",
	phantom_task_create: "operator",
	phantom_task_status: "read",
	phantom_config: "read",
	phantom_history: "read",
	phantom_metrics: "read",
	phantom_register_tool: "admin",
	phantom_unregister_tool: "admin",
	phantom_list_dynamic_tools: "read",
	// SWE tools that invoke the agent brain need operator scope
	phantom_review_request: "operator",
	phantom_codebase_query: "read",
	phantom_pr_status: "read",
	phantom_ci_status: "read",
	phantom_deploy_status: "read",
	phantom_repo_info: "read",
};

export function getRequiredScope(toolName: string): McpScope {
	return TOOL_SCOPES[toolName] ?? "read";
}
