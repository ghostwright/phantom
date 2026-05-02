import type { Database } from "bun:sqlite";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { executeDynamicHandler } from "./dynamic-handlers.ts";

const DYNAMIC_TOOLS_MIGRATION = `CREATE TABLE IF NOT EXISTS dynamic_tools (
	name TEXT PRIMARY KEY,
	description TEXT NOT NULL,
	input_schema TEXT NOT NULL,
	handler_type TEXT NOT NULL DEFAULT 'inline',
	handler_code TEXT,
	handler_path TEXT,
	registered_at TEXT NOT NULL DEFAULT (datetime('now')),
	registered_by TEXT
)`;

export type DynamicToolRow = {
	name: string;
	description: string;
	input_schema: string;
	handler_type: "script" | "shell";
	handler_code: string | null;
	handler_path: string | null;
	registered_at: string;
	registered_by: string | null;
};

export type DynamicToolDef = {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	handlerType: "script" | "shell";
	handlerCode?: string;
	handlerPath?: string;
	registeredBy?: string;
};

const ToolNameSchema = z
	.string()
	.min(1)
	.max(100)
	.regex(/^[a-z][a-z0-9_]*$/, "Tool name must be lowercase alphanumeric with underscores, starting with a letter");

const RegisterToolInputSchema = z.object({
	name: ToolNameSchema,
	description: z.string().min(1).max(1000),
	input_schema: z.record(z.unknown()).default({}),
	handler_type: z.enum(["script", "shell"]).default("shell"),
	handler_code: z.string().optional(),
	handler_path: z.string().optional(),
});

export class DynamicToolRegistry {
	private db: Database;
	private tools: Map<string, DynamicToolDef> = new Map();

	constructor(db: Database) {
		this.db = db;
		this.db.run(DYNAMIC_TOOLS_MIGRATION);
		this.loadFromDatabase();
	}

	private loadFromDatabase(): void {
		const rows = this.db.query("SELECT * FROM dynamic_tools").all() as DynamicToolRow[];
		for (const row of rows) {
			try {
				const def: DynamicToolDef = {
					name: row.name,
					description: row.description,
					inputSchema: JSON.parse(row.input_schema),
					handlerType: row.handler_type,
					handlerCode: row.handler_code ?? undefined,
					handlerPath: row.handler_path ?? undefined,
					registeredBy: row.registered_by ?? undefined,
				};
				this.tools.set(row.name, def);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[dynamic-tools] Failed to load tool '${row.name}': ${msg}`);
			}
		}

		if (this.tools.size > 0) {
			console.log(`[dynamic-tools] Loaded ${this.tools.size} dynamic tool(s) from database`);
		}
	}

	register(input: z.infer<typeof RegisterToolInputSchema>): DynamicToolDef {
		const parsed = RegisterToolInputSchema.parse(input);

		if (parsed.handler_type === "script" && !parsed.handler_path) {
			throw new Error("handler_path is required for script handler type");
		}
		if (parsed.handler_type === "shell" && !parsed.handler_code) {
			throw new Error("handler_code is required for shell handler type");
		}

		const def: DynamicToolDef = {
			name: parsed.name,
			description: parsed.description,
			inputSchema: parsed.input_schema,
			handlerType: parsed.handler_type,
			handlerCode: parsed.handler_code,
			handlerPath: parsed.handler_path,
		};

		this.db.run(
			`INSERT OR REPLACE INTO dynamic_tools (name, description, input_schema, handler_type, handler_code, handler_path)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			[
				def.name,
				def.description,
				JSON.stringify(def.inputSchema),
				def.handlerType,
				def.handlerCode ?? null,
				def.handlerPath ?? null,
			],
		);

		this.tools.set(def.name, def);
		console.log(`[dynamic-tools] Registered tool: ${def.name}`);
		return def;
	}

	unregister(name: string): boolean {
		if (!this.tools.has(name)) return false;
		this.db.run("DELETE FROM dynamic_tools WHERE name = ?", [name]);
		this.tools.delete(name);
		console.log(`[dynamic-tools] Unregistered tool: ${name}`);
		return true;
	}

	getAll(): DynamicToolDef[] {
		return Array.from(this.tools.values());
	}

	get(name: string): DynamicToolDef | undefined {
		return this.tools.get(name);
	}

	has(name: string): boolean {
		return this.tools.has(name);
	}

	count(): number {
		return this.tools.size;
	}

	registerAllOnServer(server: McpServer): void {
		for (const tool of this.tools.values()) {
			try {
				registerDynamicToolOnServer(server, tool);
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[dynamic-tools] Failed to register '${tool.name}' on MCP server: ${msg}`);
			}
		}
	}
}

export function registerDynamicToolOnServer(server: McpServer, tool: DynamicToolDef): void {
	const zodSchema = buildZodSchema(tool.inputSchema);

	server.registerTool(
		tool.name,
		{ description: tool.description, inputSchema: zodSchema },
		async (input): Promise<CallToolResult> => executeDynamicHandler(tool, input),
	);
}

function buildZodSchema(schema: Record<string, unknown>): z.ZodObject<Record<string, z.ZodTypeAny>> {
	const shape: Record<string, z.ZodTypeAny> = {};

	for (const [key, value] of Object.entries(schema)) {
		const typeName = typeof value === "string" ? value : String(value);
		switch (typeName) {
			case "string":
				shape[key] = z.string().optional();
				break;
			case "number":
				shape[key] = z.number().optional();
				break;
			case "boolean":
				shape[key] = z.boolean().optional();
				break;
			default:
				shape[key] = z.unknown().optional();
				break;
		}
	}

	return z.object(shape);
}

export { RegisterToolInputSchema };
