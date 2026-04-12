import { z } from "zod";

export const OnboardingQuestionSchema = z.object({
	id: z.string().min(1),
	question: z.string().min(1),
	type: z.enum(["text", "choice", "multiline"]),
	required: z.boolean().default(true),
	choices: z.array(z.string()).optional(),
	placeholder: z.string().optional(),
});

export type OnboardingQuestion = z.infer<typeof OnboardingQuestionSchema>;

export const EvolutionFocusSchema = z.object({
	priorities: z.array(z.string().min(1)).min(1),
	feedback_signals: z.array(z.string().min(1)).default([]),
});

export type EvolutionFocus = z.infer<typeof EvolutionFocusSchema>;

export const McpToolDefinitionSchema = z.object({
	name: z.string().min(1),
	description: z.string().min(1),
});

export type McpToolDefinition = z.infer<typeof McpToolDefinitionSchema>;

export const InitialConfigSchema = z.object({
	persona: z.string().default(""),
	domain_knowledge: z.string().default(""),
	task_patterns: z.string().default(""),
	tool_preferences: z.string().default(""),
});

export type InitialConfig = z.infer<typeof InitialConfigSchema>;

export const RoleConfigSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	description: z.string().min(1),
	identity: z.string().min(1),
	capabilities: z.array(z.string().min(1)).min(1),
	communication: z.string().min(1),
	workflow_spec: z.string().default(""),
	onboarding_questions: z.array(OnboardingQuestionSchema).default([]),
	mcp_tools: z.array(McpToolDefinitionSchema).default([]),
	evolution_focus: EvolutionFocusSchema,
	initial_config: InitialConfigSchema.default({}),
});

export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export type RoleTemplate = RoleConfig & {
	systemPromptSection: string;
};

export type RoleToolHandler = (
	args: Record<string, unknown>,
	context: RoleToolContext,
) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;

export type RoleToolContext = {
	memory: unknown;
	evolution: unknown;
	config: unknown;
};

export type RoleToolRegistration = {
	name: string;
	description: string;
	inputSchema: z.ZodObject<z.ZodRawShape>;
	handler: RoleToolHandler;
};

export type RoleModule = {
	tools?: RoleToolRegistration[];
};
