// Zod schemas + types for the /ui/api/phantom-config endpoint.
//
// Kept separate from the handler so the schema surface is small and auditable
// on its own. Every schema on this file is .strict() so unknown keys reject at
// parse time. That is the secrets denylist: ANTHROPIC_API_KEY, Slack tokens,
// email passwords, webhook secrets, and any other env-only field are NOT part
// of the shape here and therefore cannot be written through the UI.

import { z } from "zod";
import { EvolutionUiConfigSchema, PermissionsConfigSchema, PhantomConfigSchema } from "../../config/schemas.ts";

const ChannelEnabledSchema = z.object({ enabled: z.boolean().default(false) });

const ChannelsUiSchema = z
	.object({
		slack: ChannelEnabledSchema.default({}),
		telegram: ChannelEnabledSchema.default({}),
		email: ChannelEnabledSchema.default({}),
		webhook: ChannelEnabledSchema.default({}),
	})
	.default({});

const MemoryUiSchema = z
	.object({
		qdrant_url: z.string().url(),
		ollama_url: z.string().url(),
		embedding_model: z.string().min(1),
		episode_limit: z.number().int().min(1).max(500),
		fact_limit: z.number().int().min(1).max(1000),
		procedure_limit: z.number().int().min(1).max(500),
	})
	.strict();

// Full UI shape. Drives GET responses and is re-validated after every PUT's
// deep merge so cross-field invariants (e.g. empty name after a patch) are
// caught before anything touches disk.
export const PhantomConfigForUiSchema = z
	.object({
		name: PhantomConfigSchema.shape.name,
		role: z.string().min(1),
		public_url: z.string().url().nullable().optional(),
		domain: z.string().min(1).nullable().optional(),
		model: z.string().min(1),
		judge_model: z.string().min(1).nullable().optional(),
		effort: PhantomConfigSchema.shape.effort,
		max_budget_usd: z.number().min(0).max(100_000),
		timeout_minutes: z.number().int().min(1).max(1440),
		permissions: PermissionsConfigSchema,
		evolution: EvolutionUiConfigSchema,
		channels: ChannelsUiSchema,
		memory: MemoryUiSchema,
	})
	.strict();

export type PhantomConfigForUi = z.infer<typeof PhantomConfigForUiSchema>;

// Partial schema for PUT bodies. Each top-level slice is independently
// optional; inside a slice, nested objects are partialized so a caller can
// update only the fields they care about. .strict() at every level so unknown
// keys reject.
export const PhantomConfigPutSchema = z
	.object({
		name: PhantomConfigSchema.shape.name.optional(),
		role: z.string().min(1).optional(),
		public_url: z.string().url().nullable().optional(),
		domain: z.string().min(1).nullable().optional(),
		model: z.string().min(1).optional(),
		judge_model: z.string().min(1).nullable().optional(),
		effort: PhantomConfigSchema.shape.effort.optional(),
		max_budget_usd: z.number().min(0).max(100_000).optional(),
		timeout_minutes: z.number().int().min(1).max(1440).optional(),
		permissions: z
			.object({
				default_mode: z.enum(["default", "acceptEdits", "bypassPermissions"]).optional(),
				allow: z.array(z.string().min(1)).optional(),
				deny: z.array(z.string().min(1)).optional(),
			})
			.strict()
			.optional(),
		evolution: z
			.object({
				reflection_enabled: z.enum(["auto", "always", "never"]).optional(),
				cadence_minutes: z.number().int().min(1).max(10080).optional(),
				demand_trigger_depth: z.number().int().min(1).max(1000).optional(),
			})
			.strict()
			.optional(),
		channels: z
			.object({
				slack: z.object({ enabled: z.boolean() }).strict().optional(),
				telegram: z.object({ enabled: z.boolean() }).strict().optional(),
				email: z.object({ enabled: z.boolean() }).strict().optional(),
				webhook: z.object({ enabled: z.boolean() }).strict().optional(),
			})
			.strict()
			.optional(),
		memory: z
			.object({
				qdrant_url: z.string().url().optional(),
				ollama_url: z.string().url().optional(),
				embedding_model: z.string().min(1).optional(),
				episode_limit: z.number().int().min(1).max(500).optional(),
				fact_limit: z.number().int().min(1).max(1000).optional(),
				procedure_limit: z.number().int().min(1).max(500).optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type PhantomConfigPut = z.infer<typeof PhantomConfigPutSchema>;

export type SectionKey = "identity" | "model_cost" | "evolution" | "channels" | "memory" | "permissions";

export type AppliedChange = {
	section: SectionKey;
	field: string;
	previous: unknown;
	next: unknown;
};

export type PhantomConfigAuditEntry = {
	id: number;
	section: string | null;
	field: string;
	previous_value: string | null;
	new_value: string | null;
	actor: string;
	created_at: string;
};

export type PhantomConfigPaths = {
	phantomYaml: string;
	channelsYaml: string;
	evolutionMeta: string;
};
