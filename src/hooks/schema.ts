// Zod schemas for the Claude Agent SDK hooks slice of settings.json.
//
// Authoritative source: sdk.d.ts:2736-2861 (Settings.hooks field in the CLI's
// own TypeScript surface). The schema models the 26 hook events (sdk.d.ts:551)
// and the four hook type discriminated union (command | prompt | agent | http),
// per matcher group, per event.
//
// Design principles:
//   1. .strict() on every object so unknown fields surface as validation errors
//      (protects against typos that silently do nothing).
//   2. timeouts bounded to 1-3600 seconds to prevent denial-of-service via
//      runaway hooks.
//   3. env var names validated as [A-Z_][A-Z0-9_]* so header interpolation
//      cannot smuggle in shell expressions.
//   4. http URLs validated as full URLs at parse time.

import { z } from "zod";

export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"Notification",
	"UserPromptSubmit",
	"SessionStart",
	"SessionEnd",
	"Stop",
	"StopFailure",
	"SubagentStart",
	"SubagentStop",
	"PreCompact",
	"PostCompact",
	"PermissionRequest",
	"Setup",
	"TeammateIdle",
	"TaskCreated",
	"TaskCompleted",
	"Elicitation",
	"ElicitationResult",
	"ConfigChange",
	"WorktreeCreate",
	"WorktreeRemove",
	"InstructionsLoaded",
	"CwdChanged",
	"FileChanged",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];
export const HookEventSchema = z.enum(HOOK_EVENTS);

// Events that accept a tool-name or source-name matcher per sdk.d.ts
// descriptions. Events not in this set ignore the matcher field.
export const EVENTS_SUPPORTING_MATCHER: ReadonlySet<HookEvent> = new Set([
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"SubagentStart",
	"SubagentStop",
	"Elicitation",
	"ElicitationResult",
	"ConfigChange",
	"InstructionsLoaded",
	"FileChanged",
]);

const timeoutSchema = z.number().int().min(1).max(3600);
const envVarNameSchema = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "env var names must match [A-Z_][A-Z0-9_]*");

const CommandHookSchema = z
	.object({
		type: z.literal("command"),
		command: z.string().min(1).max(10_000),
		shell: z.enum(["bash", "powershell"]).optional(),
		timeout: timeoutSchema.optional(),
		statusMessage: z.string().max(120).optional(),
		once: z.boolean().optional(),
		async: z.boolean().optional(),
		asyncRewake: z.boolean().optional(),
	})
	.strict();

const PromptHookSchema = z
	.object({
		type: z.literal("prompt"),
		prompt: z.string().min(1).max(4000),
		timeout: timeoutSchema.optional(),
		model: z.string().optional(),
		statusMessage: z.string().max(120).optional(),
		once: z.boolean().optional(),
	})
	.strict();

const AgentHookSchema = z
	.object({
		type: z.literal("agent"),
		prompt: z.string().min(1).max(4000),
		timeout: timeoutSchema.optional(),
		model: z.string().optional(),
		statusMessage: z.string().max(120).optional(),
		once: z.boolean().optional(),
	})
	.strict();

const HttpHookSchema = z
	.object({
		type: z.literal("http"),
		url: z.string().url(),
		timeout: timeoutSchema.optional(),
		headers: z.record(z.string(), z.string()).optional(),
		allowedEnvVars: z.array(envVarNameSchema).optional(),
		statusMessage: z.string().max(120).optional(),
		once: z.boolean().optional(),
	})
	.strict();

export const HookDefinitionSchema = z.discriminatedUnion("type", [
	CommandHookSchema,
	PromptHookSchema,
	AgentHookSchema,
	HttpHookSchema,
]);

export type HookDefinition = z.infer<typeof HookDefinitionSchema>;

export const HookMatcherGroupSchema = z
	.object({
		matcher: z.string().optional(),
		hooks: z.array(HookDefinitionSchema).min(1),
	})
	.strict();

export type HookMatcherGroup = z.infer<typeof HookMatcherGroupSchema>;

export const HooksSliceSchema = z.record(HookEventSchema, z.array(HookMatcherGroupSchema));
export type HooksSlice = z.infer<typeof HooksSliceSchema>;

// Match an http hook URL against an operator-provided allowlist.
// Allowlist entries may contain * wildcards. An empty allowlist means
// the field is unset and every URL is allowed (matches CLI default).
// If the allowlist is set to an empty array, no http hooks are allowed.
export function isHttpUrlAllowed(url: string, allowlist?: string[]): boolean {
	if (!allowlist) return true;
	if (allowlist.length === 0) return false;
	for (const pattern of allowlist) {
		const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
		const re = new RegExp(`^${escaped}$`);
		if (re.test(url)) return true;
	}
	return false;
}
