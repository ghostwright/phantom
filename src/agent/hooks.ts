import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "./agent-sdk.ts";

// Defense-in-depth command blocker. This is NOT a security boundary.
// These patterns catch common mistakes and obvious destructive commands.
// The real security layers are: the agent's constitution (immutable behavioral
// rules), LLM safety judges in the evolution pipeline (independent review),
// owner access control (only the owner can talk to the agent), and network
// egress controls (firewall rules restricting outbound connections).
// A determined adversary can bypass regex patterns via encoding, variable
// substitution, or indirect execution. Defense in depth means no single
// layer is relied upon alone.
const DANGEROUS_COMMANDS: { pattern: RegExp; label: string }[] = [
	{ pattern: /docker\s+compose\s+down/, label: "docker compose down" },
	{ pattern: /docker\s+volume\s+prune/, label: "docker volume prune" },
	{ pattern: /docker\s+system\s+prune/, label: "docker system prune" },
	{ pattern: /git\s+push\s+.*--force/, label: "git push --force" },
	{ pattern: /git\s+reset\s+--hard/, label: "git reset --hard" },
	{ pattern: /rm\s+-rf\s+\/(\s|$)/, label: "rm -rf /" },
	{ pattern: /rm\s+-rf\s+\/home(\s|$)/, label: "rm -rf /home" },
	{ pattern: /rm\s+-rf\s+\/etc(\s|$)/, label: "rm -rf /etc" },
	{ pattern: /rm\s+-rf\s+\/var(\s|$)/, label: "rm -rf /var" },
	{ pattern: /mkfs\./, label: "mkfs (format filesystem)" },
	{ pattern: /dd\s+.*of=\/dev\//, label: "dd to device" },
	{ pattern: /systemctl\s+(stop|disable)\s+phantom/, label: "stop phantom service" },
	{ pattern: /kill\s+-9\s+1(\s|$)/, label: "kill init" },
];

export function createFileTracker(): {
	hook: HookCallbackMatcher;
	getTrackedFiles: () => string[];
} {
	const trackedFiles = new Set<string>();

	const hook: HookCallbackMatcher = {
		matcher: "Edit|Write",
		hooks: [
			async (input: HookInput): Promise<HookJSONOutput> => {
				if (input.hook_event_name !== "PostToolUse") return { continue: true };
				const filePath = (input.tool_input as Record<string, unknown>)?.file_path;
				if (typeof filePath === "string") {
					trackedFiles.add(filePath);
				}
				return { continue: true };
			},
		],
	};

	return {
		hook,
		getTrackedFiles: () => [...trackedFiles],
	};
}

export function createDangerousCommandBlocker(): HookCallbackMatcher {
	return {
		matcher: "Bash",
		hooks: [
			async (input: HookInput): Promise<HookJSONOutput> => {
				if (input.hook_event_name !== "PreToolUse") return { continue: true };
				const command = (input.tool_input as Record<string, unknown>)?.command;
				if (typeof command === "string") {
					for (const { pattern, label } of DANGEROUS_COMMANDS) {
						if (pattern.test(command)) {
							return {
								decision: "block",
								reason: `Blocked dangerous command: "${label}"`,
							};
						}
					}
				}
				return { continue: true };
			},
		],
	};
}
