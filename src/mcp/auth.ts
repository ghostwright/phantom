import type { AuthResult, McpConfig, McpScope } from "./types.ts";

export class AuthMiddleware {
	private tokenMap: Map<string, { name: string; scopes: McpScope[] }>;

	constructor(config: McpConfig) {
		this.tokenMap = new Map();
		for (const token of config.tokens) {
			this.tokenMap.set(token.hash, { name: token.name, scopes: token.scopes });
		}
	}

	async authenticate(req: Request): Promise<AuthResult> {
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
