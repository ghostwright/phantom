import { z } from "zod";

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
	model: z.string().min(1).default("claude-sonnet-4-6"),
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
	clawmem: z
		.object({
			store_path: z.string().min(1).default("data/clawmem.sqlite"),
			embed_model: z.string().min(1).default("embedding"),
			busy_timeout_ms: z.number().int().nonnegative().default(5000),
		})
		.default({}),
	collections: z
		.object({
			episodes: z.string().min(1).default("episodes"),
			semantic_facts: z.string().min(1).default("semantic_facts"),
			procedures: z.string().min(1).default("procedures"),
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
