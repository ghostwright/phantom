import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getInstallationToken } from "../integrations/github-app.ts";
import { buildSafeEnv } from "../mcp/dynamic-handlers.ts";
import { type ProcessLimits, drainProcessWithLimits } from "../utils/process.ts";

/** Limits for phantom_gh_exec command execution */
const GH_EXEC_LIMITS: ProcessLimits = {
	timeoutMs: 120_000, // 2 minutes
	maxOutputBytes: 1_000_000, // 1 MB
};

// Shell metacharacters that could enable injection attacks
const SHELL_METACHARACTERS = /[;|&$`><(){}[\]]/;

/**
 * Subcommands blocked for gh CLI due to token disclosure risk.
 *
 * - auth: `gh auth token` prints the GH_TOKEN
 * - secret: repository secrets management
 * - config: credential configuration
 * - ssh-key: SSH key management
 * - gpg-key: GPG key management
 */
const GH_BLOCKED_SUBCOMMANDS = new Set(["auth", "secret", "config", "ssh-key", "gpg-key"]);

/**
 * Validate that a gh/git command doesn't use subcommands that could leak tokens.
 *
 * For gh: blocks known token-disclosure subcommands (auth, secret, etc.)
 * For git: blocks -c flag which can run arbitrary commands via alias.x=!cmd
 */
export function validateGhSubcommand(
	binary: "gh" | "git",
	args: string[],
): { valid: true } | { valid: false; error: string } {
	if (binary === "gh") {
		// First positional argument is the subcommand
		const subcommand = args[0]?.toLowerCase();
		if (subcommand && GH_BLOCKED_SUBCOMMANDS.has(subcommand)) {
			return {
				valid: false,
				error: `The 'gh ${subcommand}' subcommand is blocked because it can expose authentication tokens.`,
			};
		}
	}

	if (binary === "git") {
		// Block -c/--config flag which can run arbitrary commands via alias.x=!cmd
		// e.g., git -c alias.x=!env x -> prints all env vars including GH_TOKEN
		// Also blocks: git --config alias.x=!env x (space-separated form)
		for (const arg of args) {
			if (arg === "-c" || arg.startsWith("-c=") || arg === "--config" || arg.startsWith("--config=")) {
				return {
					valid: false,
					error:
						"The 'git -c/--config' flag is blocked because it can execute arbitrary commands. Use 'git config --local' instead.",
				};
			}
		}
	}

	return { valid: true };
}

/**
 * Patterns that match GitHub tokens in output.
 *
 * - ghs_: GitHub App installation access tokens
 * - gho_: OAuth access tokens
 * - ghp_: Personal access tokens (classic)
 * - ghu_: User-to-server tokens
 * - github_pat_: Fine-grained personal access tokens
 */
const GITHUB_TOKEN_PATTERNS = [
	/\bgh[spou]_[A-Za-z0-9]{36,}\b/g, // ghs_, gho_, ghp_, ghu_
	/\bgithub_pat_[A-Za-z0-9_]{59,}\b/g, // fine-grained PATs
];

/**
 * Redact GitHub tokens from command output as defense-in-depth.
 *
 * Even though we block commands that print tokens (gh auth token, git -c alias),
 * this provides an additional safety layer in case a new disclosure vector is
 * discovered or the blocklist is bypassed.
 *
 * @param text - The output text to scan
 * @param knownToken - The specific token used in this execution (always redacted)
 * @returns Text with tokens replaced by [REDACTED]
 */
export function redactTokensFromOutput(text: string, knownToken: string): string {
	if (!text) return text;

	let result = text;

	// Always redact the known token first (exact match)
	if (knownToken && result.includes(knownToken)) {
		result = result.replaceAll(knownToken, "[REDACTED]");
	}

	// Then scan for any other GitHub token patterns
	for (const pattern of GITHUB_TOKEN_PATTERNS) {
		// Reset regex state (global flag)
		pattern.lastIndex = 0;
		result = result.replace(pattern, "[REDACTED]");
	}

	return result;
}

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

	// Validate subcommand isn't a token-disclosure command
	const subcommandValidation = validateGhSubcommand(input.binary, input.args);
	if (!subcommandValidation.valid) {
		return {
			content: [{ type: "text" as const, text: JSON.stringify({ error: subcommandValidation.error }) }],
			isError: true,
		};
	}

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

		// Drain stdout/stderr concurrently with timeout and output limits
		const {
			stdout: rawStdout,
			stderr: rawStderr,
			exitCode,
			timedOut,
		} = await drainProcessWithLimits(proc, GH_EXEC_LIMITS);

		if (timedOut) {
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify({
							error: `Command timed out after ${GH_EXEC_LIMITS.timeoutMs / 1000} seconds`,
							partialStderr: redactTokensFromOutput(rawStderr.slice(0, 500), token),
						}),
					},
				],
				isError: true,
			};
		}

		// Redact any tokens from output as defense-in-depth
		const stdout = redactTokensFromOutput(rawStdout.trim(), token);
		const stderr = redactTokensFromOutput(rawStderr.trim(), token);

		const result = { stdout, stderr, exitCode };

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
