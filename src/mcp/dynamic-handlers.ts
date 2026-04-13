import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Subprocess } from "bun";
import type { DynamicToolDef } from "./dynamic-tools.ts";

const DEFAULT_HANDLER_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const HANDLER_GRACE_MS = 2_000;

type HandlerLimits = { timeoutMs: number; maxOutputBytes: number };

function getHandlerLimits(): HandlerLimits {
	return {
		timeoutMs: Number(process.env.PHANTOM_DYNAMIC_HANDLER_TIMEOUT_MS ?? DEFAULT_HANDLER_TIMEOUT_MS),
		maxOutputBytes: Number(process.env.PHANTOM_DYNAMIC_HANDLER_MAX_OUTPUT_BYTES ?? DEFAULT_MAX_OUTPUT_BYTES),
	};
}

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

/**
 * Drain a ReadableStream with a hard byte cap.
 *
 * Critically, we keep reading (and dropping) chunks past the cap so the child
 * process never blocks on a full 64 KB pipe buffer. Cancelling the reader would
 * be simpler but risks leaving the child stuck on its next write.
 */
async function readStreamWithCap(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (truncated) continue;
			if (totalBytes + value.byteLength > maxBytes) {
				const remaining = maxBytes - totalBytes;
				if (remaining > 0) chunks.push(value.subarray(0, remaining));
				totalBytes = maxBytes;
				truncated = true;
			} else {
				chunks.push(value);
				totalBytes += value.byteLength;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	const text = new TextDecoder().decode(combined);
	return {
		text: truncated ? `${text}\n\n_(Output truncated at ${maxBytes} bytes.)_` : text,
		truncated,
	};
}

type DrainResult = {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
};

/**
 * Run a spawned subprocess with concurrent pipe drains, a hard timeout, and
 * stdout/stderr size caps. Concurrent drains prevent the classic sequential
 * drain deadlock (child blocks on stderr write while parent waits for stdout
 * EOF). Timeout fires SIGTERM, escalates to SIGKILL after a grace period.
 */
async function drainProcessWithLimits(
	proc: Subprocess<"pipe" | "ignore" | "inherit", "pipe", "pipe">,
	limits: HandlerLimits,
): Promise<DrainResult> {
	let timedOut = false;
	const termTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
	}, limits.timeoutMs);
	const killTimer = setTimeout(() => {
		proc.kill("SIGKILL");
	}, limits.timeoutMs + HANDLER_GRACE_MS);

	try {
		const [stdoutResult, stderrResult] = await Promise.all([
			readStreamWithCap(proc.stdout, limits.maxOutputBytes),
			readStreamWithCap(proc.stderr, limits.maxOutputBytes),
		]);
		await proc.exited;
		return {
			stdout: stdoutResult.text,
			stderr: stderrResult.text,
			exitCode: proc.exitCode,
			timedOut,
		};
	} finally {
		clearTimeout(termTimer);
		clearTimeout(killTimer);
	}
}

function timeoutResult(toolName: string, timeoutMs: number, partial: string): CallToolResult {
	const snippet = partial.slice(0, 500);
	return {
		content: [
			{
				type: "text",
				text: `Tool '${toolName}' timed out after ${timeoutMs}ms and was killed. Partial output: ${snippet}`,
			},
		],
		isError: true,
	};
}

export async function executeDynamicHandler(
	tool: DynamicToolDef,
	input: Record<string, unknown>,
): Promise<CallToolResult> {
	try {
		switch (tool.handlerType) {
			case "script":
				return executeScriptHandler(tool, input);
			case "shell":
				return executeShellHandler(tool, input);
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

async function executeScriptHandler(tool: DynamicToolDef, input: Record<string, unknown>): Promise<CallToolResult> {
	const path = tool.handlerPath ?? "";
	const { existsSync } = await import("node:fs");
	if (!existsSync(path)) {
		return {
			content: [{ type: "text", text: `Script not found: ${path}` }],
			isError: true,
		};
	}

	const limits = getHandlerLimits();

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

	const { stdout, stderr, exitCode, timedOut } = await drainProcessWithLimits(proc, limits);

	if (timedOut) {
		return timeoutResult(tool.name, limits.timeoutMs, stderr || stdout);
	}

	if (exitCode !== 0) {
		return {
			content: [{ type: "text", text: `Script error (exit ${exitCode}): ${stderr || stdout}` }],
			isError: true,
		};
	}

	return { content: [{ type: "text", text: stdout.trim() }] };
}

async function executeShellHandler(tool: DynamicToolDef, input: Record<string, unknown>): Promise<CallToolResult> {
	const command = tool.handlerCode ?? "";
	const limits = getHandlerLimits();

	const proc = Bun.spawn(["bash", "-c", command], {
		stdout: "pipe",
		stderr: "pipe",
		env: buildSafeEnv(input),
	});

	const { stdout, stderr, exitCode, timedOut } = await drainProcessWithLimits(proc, limits);

	if (timedOut) {
		return timeoutResult(tool.name, limits.timeoutMs, stderr || stdout);
	}

	if (exitCode !== 0) {
		return {
			content: [{ type: "text", text: `Shell error (exit ${exitCode}): ${stderr || stdout}` }],
			isError: true,
		};
	}

	return { content: [{ type: "text", text: stdout.trim() }] };
}
