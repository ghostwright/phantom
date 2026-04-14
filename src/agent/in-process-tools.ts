import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getInstallationToken } from "../integrations/github-app.ts";
import { buildSafeEnv } from "../mcp/dynamic-handlers.ts";
import type { DynamicToolRegistry } from "../mcp/dynamic-tools.ts";

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

// Shell metacharacters that could enable injection attacks
const SHELL_METACHARACTERS = /[;|&$`><(){}[\]]/;

/**
 * Validate that args don't contain shell metacharacters.
 * Since we use Bun.spawn with args array, the shell doesn't interpret these,
 * but we reject them anyway as defense in depth.
 */
export function validateGhExecArgs(args: string[]): { valid: true } | { valid: false; error: string } {
	for (const arg of args) {
		if (SHELL_METACHARACTERS.test(arg)) {
			return {
				valid: false,
				error: `Argument contains shell metacharacter: "${arg}". This is not allowed for security reasons.`,
			};
		}
	}
	return { valid: true };
}

type GhExecInput = {
	binary: "gh" | "git";
	args: string[];
	cwd?: string;
};

type GhExecOptions = {
	tokenGetter?: () => Promise<string>;
};

/**
 * Execute a gh or git command with GitHub App authentication.
 * Exported for testing - the MCP tool wraps this.
 *
 * @param input - The command input
 * @param options - Optional configuration. tokenGetter allows dependency injection for testing.
 */
export async function executeGhExec(
	input: GhExecInput,
	options?: GhExecOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	const tokenGetter = options?.tokenGetter ?? getInstallationToken;

	// Validate args for shell metacharacters
	const validation = validateGhExecArgs(input.args);
	if (!validation.valid) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: validation.error }) }],
			isError: true,
		};
	}

	try {
		// Get the installation token (cached, refreshes automatically)
		const token = await tokenGetter();

		// Build safe environment with only GH_TOKEN added
		const env = buildSafeEnv({}, { GH_TOKEN: token });

		// Spawn the process with args as array (no shell interpretation)
		const proc = Bun.spawn([input.binary, ...input.args], {
			stdout: "pipe",
			stderr: "pipe",
			env,
			cwd: input.cwd,
		});

		// Read stdout and stderr
		const stdoutText = await new Response(proc.stdout).text();
		const stderrText = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		// Build result - NEVER include the token
		const result = {
			stdout: stdoutText.trim(),
			stderr: stderrText.trim(),
			exitCode,
		};

		if (exitCode !== 0) {
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				isError: true,
			};
		}

		return {
			content: [{ type: "text" as const, text: JSON.stringify(result) }],
		};
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: msg }) }],
			isError: true,
		};
	}
}

/**
 * Creates an in-process SDK MCP server that exposes GitHub CLI tools.
 * The GH_TOKEN is injected into the subprocess environment, never exposed to the model.
 */
export function createGitHubToolServer(): McpSdkServerConfigWithInstance {
	const ghExecTool = tool(
		"phantom_gh_exec",
		"Execute gh or git commands with GitHub App authentication. " +
			"The authentication token is injected into the subprocess environment and never returned in the result. " +
			"Use this for all GitHub operations: cloning repos, creating PRs, managing issues, etc.",
		{
			binary: z.enum(["gh", "git"]).describe("The binary to execute: 'gh' for GitHub CLI, 'git' for git commands"),
			args: z.array(z.string()).describe("Arguments to pass to the binary"),
			cwd: z.string().optional().describe("Working directory for the command"),
		},
		(input) => executeGhExec(input),
	);

	return createSdkMcpServer({
		name: "phantom-github",
		tools: [ghExecTool],
	});
}
