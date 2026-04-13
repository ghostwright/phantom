import { z } from "zod";
import { ProviderSchema } from "./providers.ts";

export const PeerConfigSchema = z.object({
	url: z.string().url(),
	token: z.string().min(1),
	description: z.string().optional(),
	enabled: z.boolean().default(true),
});

export const PhantomConfigSchema = z.object({
	name: z.string().min(1),
	domain: z.string().optional(),
	public_url: z.string().url().optional(),
	port: z.number().int().min(1).max(65535).default(3100),
	role: z.string().min(1).default("swe"),
	model: z.string().min(1).default("claude-opus-4-6"),
	model_source: z.enum(["config", "env"]).default("config"),
	// Optional override for the model used by evolution judges. Defaults to `model` when omitted
	// so a single-model deployment "just works". Lets operators run a cheaper model for judging
	// while keeping a more capable model for the primary agent.
	judge_model: z.string().min(1).optional(),
	// Provider selection. Defaults to { type: "anthropic" }, which is identical in behavior to
	// omitting the block entirely and matches every deployment that existed before Phase 2.
	// The effective env vars are computed by buildProviderEnv() in config/providers.ts and
	// merged into the Agent SDK subprocess environment at query() time.
	provider: ProviderSchema,
	effort: z.enum(["low", "medium", "high", "max"]).default("max"),
	max_budget_usd: z.number().min(0).default(0),
	timeout_minutes: z.number().min(1).default(240),
	peers: z.record(z.string(), PeerConfigSchema).optional(),
});

export const SlackChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	bot_token: z.string().min(1),
	app_token: z.string().min(1),
	default_channel_id: z.string().optional(),
	default_user_id: z.string().optional(),
	owner_user_id: z.string().optional(),
});

export const TelegramChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	bot_token: z.string().min(1),
});

export const EmailChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	imap: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).default(993),
		user: z.string().min(1),
		pass: z.string().min(1),
		tls: z.boolean().default(true),
	}),
	smtp: z.object({
		host: z.string().min(1),
		port: z.number().int().min(1).default(587),
		user: z.string().min(1),
		pass: z.string().min(1),
		tls: z.boolean().default(false),
	}),
	from_address: z.string().email(),
	from_name: z.string().min(1).default("Phantom"),
});

export const WebhookChannelConfigSchema = z.object({
	enabled: z.boolean().default(false),
	secret: z.string().min(16),
	sync_timeout_ms: z.number().int().min(1000).default(25000),
});

export const ChannelsConfigSchema = z.object({
	slack: SlackChannelConfigSchema.optional(),
	telegram: TelegramChannelConfigSchema.optional(),
	email: EmailChannelConfigSchema.optional(),
	webhook: WebhookChannelConfigSchema.optional(),
});

export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const MemoryConfigSchema = z.object({
	qdrant: z
		.object({
			url: z.string().url().default("http://localhost:6333"),
		})
		.default({}),
	ollama: z
		.object({
			url: z.string().url().default("http://localhost:11434"),
			model: z.string().min(1).default("nomic-embed-text"),
		})
		.default({}),
	collections: z
		.object({
			episodes: z.string().min(1).default("episodes"),
			semantic_facts: z.string().min(1).default("semantic_facts"),
			procedures: z.string().min(1).default("procedures"),
		})
		.default({}),
	embedding: z
		.object({
			dimensions: z.number().int().positive().default(768),
			batch_size: z.number().int().positive().default(32),
		})
		.default({}),
	context: z
		.object({
			max_tokens: z.number().int().positive().default(50000),
			episode_limit: z.number().int().positive().default(10),
			fact_limit: z.number().int().positive().default(20),
			procedure_limit: z.number().int().positive().default(5),
		})
		.default({}),
});
