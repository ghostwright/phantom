import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DynamicToolDef } from "./dynamic-tools.ts";

/**
 * Safe environment for subprocess execution.
 * Only expose what dynamic tools legitimately need.
 * Secrets (API keys, tokens) are never passed to subprocesses.
 */
export function buildSafeEnv(input: Record<string, unknown>): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? "/tmp",
		LANG: process.env.LANG ?? "en_US.UTF-8",
		TERM: process.env.TERM ?? "xterm-256color",
		TOOL_INPUT: JSON.stringify(input),
	};
}

export async function executeDynamicHandler(
	tool: DynamicToolDef,
	input: Record<string, unknown>,
): Promise<CallToolResult> {
	try {
		switch (tool.handlerType) {
			case "script":
				return executeScriptHandler(tool.handlerPath ?? "", input);
			case "shell":
				return executeShellHandler(tool.handlerCode ?? "", input);
			default:
				return {
					content: [
						{
							type: "text",
							text: `Unknown handler type: ${tool.handlerType}. Only "script" and "shell" are supported.`,
						},
					],
					isError: true,
				};
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text", text: `Error executing tool '${tool.name}': ${msg}` }],
			isError: true,
		};
	}
}

async function executeScriptHandler(path: string, input: Record<string, unknown>): Promise<CallToolResult> {
	const { existsSync } = await import("node:fs");
	if (!existsSync(path)) {
		return {
			content: [{ type: "text", text: `Script not found: ${path}` }],
			isError: true,
		};
	}

	// --env-file= prevents bun from auto-loading .env/.env.local files,
	// which would leak secrets into the subprocess despite buildSafeEnv.
	const proc = Bun.spawn(["bun", "--env-file=", "run", path], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: buildSafeEnv(input),
	});

	proc.stdin.write(JSON.stringify(input));
	proc.stdin.end();

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	await proc.exited;

	if (proc.exitCode !== 0) {
		return {
			content: [{ type: "text", text: `Script error (exit ${proc.exitCode}): ${stderr || stdout}` }],
			isError: true,
		};
	}

	return { content: [{ type: "text", text: stdout.trim() }] };
}

async function executeShellHandler(command: string, input: Record<string, unknown>): Promise<CallToolResult> {
	const shell = new Bun.$.Shell().env(buildSafeEnv(input)).nothrow();
	const result = await shell`${{ raw: command }}`;
	const stdout = await result.text();
	const stderr = result.stderr.toString();

	if (result.exitCode !== 0) {
		return {
			content: [{ type: "text", text: `Shell error (exit ${result.exitCode}): ${stderr || stdout}` }],
			isError: true,
		};
	}

	return { content: [{ type: "text", text: stdout.trim() }] };
}
