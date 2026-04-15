import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { DynamicToolRegistry } from "../mcp/dynamic-tools.ts";

// Re-export GitHub exec functions for backwards compatibility
export {
	createGitHubToolServer,
	executeGhExec,
	redactTokensFromOutput,
	validateGhExecArgs,
	validateGhSubcommand,
} from "./gh-exec.ts";

/**
 * Creates an in-process SDK MCP server that exposes dynamic tool management
 * tools directly to the agent during conversations. This bridges the gap
 * where these tools were only available on the external MCP server.
 */
export function createInProcessToolServer(registry: DynamicToolRegistry): McpSdkServerConfigWithInstance {
	const registerTool = tool(
		"phantom_register_tool",
		"Register a new dynamic MCP tool. The tool is persisted and survives restarts. " +
			"For shell handlers, provide handler_code with a bash command. " +
			"For script handlers, provide handler_path with a path to a script file. " +
			"Tool input is available via the TOOL_INPUT environment variable (JSON string).",
		{
			name: z.string().min(1).describe("Tool name (lowercase, underscores, starts with letter)"),
			description: z.string().min(1).describe("What the tool does"),
			input_schema: z
				.record(z.unknown())
				.default({})
				.describe('Input parameter definitions, e.g. {"name": "string", "count": "number"}'),
			handler_type: z.enum(["script", "shell"]).default("shell").describe("How the tool executes"),
			handler_code: z.string().optional().describe("For shell: the bash command to execute"),
			handler_path: z.string().optional().describe("For script: path to the script file"),
		},
		async (input) => {
			try {
				const def = registry.register(input);
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify(
								{
									registered: true,
									name: def.name,
									description: def.description,
									handlerType: def.handlerType,
									note: "Tool registered and persisted. It will be available in future sessions.",
								},
								null,
								2,
							),
						},
					],
				};
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }], isError: true };
			}
		},
	);

	const unregisterTool = tool(
		"phantom_unregister_tool",
		"Remove a previously registered dynamic tool. Built-in tools cannot be removed.",
		{
			name: z.string().min(1).describe("Name of the tool to remove"),
		},
		async ({ name }) => {
			if (name.startsWith("phantom_") && !registry.has(name)) {
				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({ error: `'${name}' is a built-in tool and cannot be removed` }),
						},
					],
					isError: true,
				};
			}

			const removed = registry.unregister(name);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							removed,
							name,
							note: removed ? "Tool removed. It will no longer be available." : "Tool not found.",
						}),
					},
				],
			};
		},
	);

	const listTool = tool("phantom_list_dynamic_tools", "List all dynamically registered tools.", {}, async () => {
		const tools = registry.getAll();
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(
						{
							count: tools.length,
							tools: tools.map((t) => ({
								name: t.name,
								description: t.description,
								handlerType: t.handlerType,
							})),
						},
						null,
						2,
					),
				},
			],
		};
	});

	return createSdkMcpServer({
		name: "phantom-dynamic-tools",
		tools: [registerTool, unregisterTool, listTool],
	});
}
