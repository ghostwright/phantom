// Curated whitelist Zod schema for the settings form.
//
// Every field here is classified in research doc 06-settings-field-classification.md
// as safe or requires-review. Never-expose fields (apiKeyHelper, modelOverrides,
// autoMemoryDirectory, hooks, enabledPlugins, etc.) are deliberately NOT
// declared: the schema uses .strict() so any unknown field in a request body
// is REJECTED at parse time. That is how the deny-list is enforced.
//
// The form also excludes hooks and enabledPlugins even though they are safe
// in principle, because each has its own dedicated editor and a double-write
// surface would be a foot gun.
//
// Edits to this list should be surgical: add a field only after walking
// through the sdk.d.ts:2576-3792 Settings interface and confirming it does
// not open a RCE, credential hijack, or cost-abuse vector.

import { z } from "zod";

const stringArray = () => z.array(z.string());

const AttributionSchema = z
	.object({
		commit: z.string().optional(),
		pr: z.string().optional(),
	})
	.strict();

const PermissionsSchema = z
	.object({
		allow: stringArray().optional(),
		deny: stringArray().optional(),
		ask: stringArray().optional(),
		defaultMode: z.enum(["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan"]).optional(),
		disableBypassPermissionsMode: z.literal("disable").optional(),
		additionalDirectories: stringArray().optional(),
	})
	.strict();

const WorktreeSchema = z
	.object({
		symlinkDirectories: stringArray().optional(),
		sparsePaths: stringArray().optional(),
	})
	.strict();

const SandboxNetworkSchema = z
	.object({
		allowedDomains: stringArray().optional(),
		allowLocalBinding: z.boolean().optional(),
		httpProxyPort: z.number().int().min(1).max(65535).optional(),
		socksProxyPort: z.number().int().min(1).max(65535).optional(),
	})
	.strict();

const SandboxFilesystemSchema = z
	.object({
		allowWrite: stringArray().optional(),
		denyWrite: stringArray().optional(),
		denyRead: stringArray().optional(),
		allowRead: stringArray().optional(),
	})
	.strict();

const SandboxRipgrepSchema = z
	.object({
		command: z.string().optional(),
		args: stringArray().optional(),
	})
	.strict();

const SandboxSchema = z
	.object({
		enabled: z.boolean().optional(),
		failIfUnavailable: z.boolean().optional(),
		autoAllowBashIfSandboxed: z.boolean().optional(),
		allowUnsandboxedCommands: z.boolean().optional(),
		network: SandboxNetworkSchema.optional(),
		filesystem: SandboxFilesystemSchema.optional(),
		ignoreViolations: z.record(z.string(), stringArray()).optional(),
		enableWeakerNestedSandbox: z.boolean().optional(),
		enableWeakerNetworkIsolation: z.boolean().optional(),
		excludedCommands: stringArray().optional(),
		ripgrep: SandboxRipgrepSchema.optional(),
	})
	.strict();

const SpinnerVerbsSchema = z
	.object({
		mode: z.enum(["append", "replace"]),
		verbs: stringArray(),
	})
	.strict();

const SpinnerTipsOverrideSchema = z
	.object({
		excludeDefault: z.boolean().optional(),
		tips: stringArray(),
	})
	.strict();

// Top-level whitelist. All fields optional (form may submit any subset).
// .strict() rejects unknown fields, which is how the deny-list is enforced.
export const CuratedSettingsSchema = z
	.object({
		// Session and transcripts
		respectGitignore: z.boolean().optional(),
		cleanupPeriodDays: z.number().int().min(0).max(3650).optional(),
		attribution: AttributionSchema.optional(),
		includeCoAuthoredBy: z.boolean().optional(),
		includeGitInstructions: z.boolean().optional(),

		// Permissions
		permissions: PermissionsSchema.optional(),

		// Model and effort
		model: z.string().optional(),
		effortLevel: z.enum(["low", "medium", "high"]).optional(),

		// MCP
		enableAllProjectMcpServers: z.boolean().optional(),
		enabledMcpjsonServers: stringArray().optional(),
		disabledMcpjsonServers: stringArray().optional(),

		// Worktree
		worktree: WorktreeSchema.optional(),

		// Hook security (note: the hooks slice itself is owned by the hooks
		// editor and NOT included here)
		disableAllHooks: z.boolean().optional(),
		defaultShell: z.enum(["bash", "powershell"]).optional(),
		allowedHttpHookUrls: stringArray().optional(),
		httpHookAllowedEnvVars: stringArray().optional(),

		// Status line (requires-review: executes a command on every render)
		statusLine: z
			.object({
				type: z.literal("command"),
				command: z.string(),
				padding: z.number().int().min(0).optional(),
			})
			.strict()
			.optional(),

		// Env injection (requires-review: injected into every query)
		env: z.record(z.string(), z.string()).optional(),

		// Sandbox
		sandbox: SandboxSchema.optional(),

		// Output style and language
		outputStyle: z.string().optional(),
		language: z.string().optional(),

		// UI toggles
		spinnerTipsEnabled: z.boolean().optional(),
		spinnerVerbs: SpinnerVerbsSchema.optional(),
		spinnerTipsOverride: SpinnerTipsOverrideSchema.optional(),
		syntaxHighlightingDisabled: z.boolean().optional(),
		terminalTitleFromRename: z.boolean().optional(),
		alwaysThinkingEnabled: z.boolean().optional(),
		fastMode: z.boolean().optional(),
		fastModePerSessionOptIn: z.boolean().optional(),
		promptSuggestionEnabled: z.boolean().optional(),
		showClearContextOnPlanAccept: z.boolean().optional(),
		showThinkingSummaries: z.boolean().optional(),
		prefersReducedMotion: z.boolean().optional(),
		feedbackSurveyRate: z.number().min(0).max(1).optional(),

		// Memory
		autoMemoryEnabled: z.boolean().optional(),
		autoDreamEnabled: z.boolean().optional(),
		claudeMdExcludes: stringArray().optional(),

		// Update channel
		autoUpdatesChannel: z.enum(["latest", "stable"]).optional(),
		minimumVersion: z.string().optional(),

		// Agent dropdown (requires-review: runs every query as that subagent)
		agent: z.string().optional(),

		// Misc
		companyAnnouncements: stringArray().optional(),
		plansDirectory: z.string().optional(),
		disableAutoMode: z.literal("disable").optional(),
		skipWebFetchPreflight: z.boolean().optional(),
		channelsEnabled: z.boolean().optional(),
		skipDangerousModePermissionPrompt: z.boolean().optional(),
		advisorModel: z.string().optional(),
	})
	.strict();

export type CuratedSettings = z.infer<typeof CuratedSettingsSchema>;

// The whitelisted top-level keys. Used by the storage layer to build the
// diff and by tests to assert the deny-list.
export const WHITELISTED_KEYS = Object.freeze([
	"respectGitignore",
	"cleanupPeriodDays",
	"attribution",
	"includeCoAuthoredBy",
	"includeGitInstructions",
	"permissions",
	"model",
	"effortLevel",
	"enableAllProjectMcpServers",
	"enabledMcpjsonServers",
	"disabledMcpjsonServers",
	"worktree",
	"disableAllHooks",
	"defaultShell",
	"allowedHttpHookUrls",
	"httpHookAllowedEnvVars",
	"statusLine",
	"env",
	"sandbox",
	"outputStyle",
	"language",
	"spinnerTipsEnabled",
	"spinnerVerbs",
	"spinnerTipsOverride",
	"syntaxHighlightingDisabled",
	"terminalTitleFromRename",
	"alwaysThinkingEnabled",
	"fastMode",
	"fastModePerSessionOptIn",
	"promptSuggestionEnabled",
	"showClearContextOnPlanAccept",
	"showThinkingSummaries",
	"prefersReducedMotion",
	"feedbackSurveyRate",
	"autoMemoryEnabled",
	"autoDreamEnabled",
	"claudeMdExcludes",
	"autoUpdatesChannel",
	"minimumVersion",
	"agent",
	"companyAnnouncements",
	"plansDirectory",
	"disableAutoMode",
	"skipWebFetchPreflight",
	"channelsEnabled",
	"skipDangerousModePermissionPrompt",
	"advisorModel",
] as const);

export const DENYLISTED_KEYS = Object.freeze([
	"apiKeyHelper",
	"awsCredentialExport",
	"awsAuthRefresh",
	"gcpAuthRefresh",
	"fileSuggestion",
	"otelHeadersHelper",
	"modelOverrides",
	"availableModels",
	"hooks",
	"enabledPlugins",
	"autoMemoryDirectory",
	"pluginTrustMessage",
	"extraKnownMarketplaces",
	"strictKnownMarketplaces",
	"strictPluginOnlyCustomization",
	"allowedMcpServers",
	"deniedMcpServers",
	"allowedChannelPlugins",
	"pluginConfigs",
	"sshConfigs",
	"remote",
	"allowManagedHooksOnly",
	"allowManagedPermissionRulesOnly",
	"allowManagedMcpServersOnly",
	"forceLoginMethod",
	"forceLoginOrgUUID",
] as const);
