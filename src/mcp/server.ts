import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentRuntime } from "../agent/runtime.ts";
import type { PhantomConfig } from "../config/types.ts";
import type { EvolutionEngine } from "../evolution/engine.ts";
import type { MemorySystem } from "../memory/system.ts";
import { AuditLogger } from "./audit.ts";
import { AuthMiddleware, getRequiredScope } from "./auth.ts";
import { loadMcpConfig } from "./config.ts";
import { DynamicToolRegistry } from "./dynamic-tools.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { registerResources } from "./resources.ts";
import { registerDynamicToolManagementTools } from "./tools-dynamic.ts";
import { registerSweTools } from "./tools-swe.ts";
import { type ToolDependencies, registerUniversalTools } from "./tools-universal.ts";
import { McpTransportManager } from "./transport.ts";

const TASKS_MIGRATION = `CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	title TEXT NOT NULL,
	description TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'queued',
	urgency TEXT NOT NULL DEFAULT 'normal',
	source_channel TEXT,
	source_client TEXT,
	result TEXT,
	cost_usd REAL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT (datetime('now')),
	started_at TEXT,
	completed_at TEXT
)`;

export type PhantomMcpServerDeps = {
	config: PhantomConfig;
	db: Database;
	startedAt: number;
	runtime: AgentRuntime;
	memory: MemorySystem | null;
	evolution: EvolutionEngine | null;
	roleId?: string;
};

export class PhantomMcpServer {
	private auth: AuthMiddleware;
	private rateLimiter: RateLimiter;
	private audit: AuditLogger;
	private transportManager: McpTransportManager;
	private toolDeps: ToolDependencies;
	private roleId: string;
	private dynamicTools: DynamicToolRegistry;

	constructor(deps: PhantomMcpServerDeps, mcpConfigPath?: string) {
		const mcpConfig = loadMcpConfig(mcpConfigPath);

		// Run tasks migration
		deps.db.run(TASKS_MIGRATION);

		this.auth = new AuthMiddleware(mcpConfig);
		this.rateLimiter = new RateLimiter(mcpConfig.rate_limit);
		this.audit = new AuditLogger(deps.db);
		this.roleId = deps.roleId ?? deps.config.role;
		this.dynamicTools = new DynamicToolRegistry(deps.db);

		this.toolDeps = {
			config: deps.config,
			db: deps.db,
			startedAt: deps.startedAt,
			runtime: deps.runtime,
			memory: deps.memory,
			evolution: deps.evolution,
		};

		this.transportManager = new McpTransportManager(() => this.createMcpServer());

		// Periodic cleanup every 5 minutes
		setInterval(() => {
			this.transportManager.cleanupStaleSessions();
			this.rateLimiter.cleanup();
		}, 300_000);
	}

	private createMcpServer(): McpServer {
		const server = new McpServer(
			{ name: `phantom-${this.toolDeps.config.name}`, version: "0.18.2" },
			{ capabilities: { logging: {} } },
		);

		registerUniversalTools(server, this.toolDeps);
		this.registerRoleTools(server);
		registerDynamicToolManagementTools(server, this.dynamicTools);
		this.dynamicTools.registerAllOnServer(server);
		registerResources(server, {
			config: this.toolDeps.config,
			db: this.toolDeps.db,
			startedAt: this.toolDeps.startedAt,
			memory: this.toolDeps.memory,
			evolution: this.toolDeps.evolution,
		});

		return server;
	}

	private registerRoleTools(server: McpServer): void {
		const roleToolMap: Record<string, (server: McpServer, deps: ToolDependencies) => void> = {
			swe: registerSweTools,
		};

		const registerFn = roleToolMap[this.roleId];
		if (registerFn) {
			registerFn(server, this.toolDeps);
			console.log(`[mcp] Registered role-specific tools for: ${this.roleId}`);
		}
	}

	async handleRequest(req: Request): Promise<Response> {
		const startTime = Date.now();

		// Authenticate
		const auth = await this.auth.authenticate(req);
		if (!auth.authenticated) {
			this.audit.log({
				client_name: "unauthenticated",
				method: req.method,
				tool_name: null,
				resource_uri: null,
				input_summary: null,
				output_summary: auth.error,
				cost_usd: 0,
				duration_ms: Date.now() - startTime,
				status: "error",
			});

			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32001, message: auth.error }, id: null },
				{ status: 401, headers: { "Content-Type": "application/json" } },
			);
		}

		// Rate limit
		const rateResult = this.rateLimiter.check(auth.clientName);
		if (!rateResult.allowed) {
			this.audit.log({
				client_name: auth.clientName,
				method: req.method,
				tool_name: null,
				resource_uri: null,
				input_summary: null,
				output_summary: "Rate limited",
				cost_usd: 0,
				duration_ms: Date.now() - startTime,
				status: "error",
			});

			return Response.json(
				{ jsonrpc: "2.0", error: { code: -32029, message: "Rate limit exceeded" }, id: null },
				{
					status: 429,
					headers: {
						"Content-Type": "application/json",
						"Retry-After": String(rateResult.retryAfter),
					},
				},
			);
		}

		// Enforce tool-level scope before the transport sees the request
		if (req.method === "POST") {
			try {
				const scopeClone = req.clone();
				const json = await scopeClone.json();
				// Handle both single and batch JSON-RPC requests
				const messages = Array.isArray(json) ? json : [json];
				for (const msg of messages) {
					if (msg?.method === "tools/call" && msg?.params?.name) {
						const required = getRequiredScope(msg.params.name);
						if (!this.auth.hasScope(auth, required)) {
							this.audit.log({
								client_name: auth.clientName,
								method: "tools/call",
								tool_name: msg.params.name,
								resource_uri: null,
								input_summary: null,
								output_summary: `Blocked: ${required} scope required`,
								cost_usd: 0,
								duration_ms: Date.now() - startTime,
								status: "error",
							});
							return Response.json(
								{
									jsonrpc: "2.0",
									error: { code: -32001, message: `Insufficient scope: ${required} required` },
									id: msg.id ?? null,
								},
								{ status: 403 },
							);
						}
					}
				}
			} catch {
				// Not JSON or not a tool call - let transport handle it
			}
		}

		// Delegate to transport manager
		const response = await this.transportManager.handleRequest(req, auth);

		// Audit log (best effort extraction of method info from the request)
		const auditInfo = await extractAuditInfo(req).catch(() => ({
			method: req.method,
			toolName: null as string | null,
			resourceUri: null as string | null,
			inputSummary: null as string | null,
		}));

		this.audit.log({
			client_name: auth.clientName,
			method: auditInfo.method,
			tool_name: auditInfo.toolName,
			resource_uri: auditInfo.resourceUri,
			input_summary: auditInfo.inputSummary,
			output_summary: null,
			cost_usd: 0,
			duration_ms: Date.now() - startTime,
			status: response.ok ? "success" : "error",
		});

		return response;
	}

	getConnectedClients(): string[] {
		return this.transportManager.getSessionClients();
	}

	getSessionCount(): number {
		return this.transportManager.getSessionCount();
	}

	getAuditLog(limit = 50): import("./types.ts").AuditEntry[] {
		return this.audit.getRecent(limit);
	}

	getDynamicToolCount(): number {
		return this.dynamicTools.count();
	}

	getDynamicToolRegistry(): DynamicToolRegistry {
		return this.dynamicTools;
	}

	async close(): Promise<void> {
		await this.transportManager.closeAll();
	}
}

async function extractAuditInfo(req: Request): Promise<{
	method: string;
	toolName: string | null;
	resourceUri: string | null;
	inputSummary: string | null;
}> {
	// Clone the request so we can read the body without consuming it
	// If the body was already consumed, just return defaults
	try {
		const clone = req.clone();
		const body = await clone.json();
		const method = body?.method ?? req.method;
		const toolName = body?.params?.name ?? null;
		const resourceUri = body?.params?.uri ?? null;
		const inputSummary = body?.params?.arguments ? JSON.stringify(body.params.arguments).slice(0, 200) : null;
		return { method, toolName, resourceUri, inputSummary };
	} catch {
		return { method: req.method, toolName: null, resourceUri: null, inputSummary: null };
	}
}
