import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInProcessToolServer } from "./agent/in-process-tools.ts";
import { AgentRuntime } from "./agent/runtime.ts";
import type { RuntimeEvent } from "./agent/runtime.ts";
import { CliChannel } from "./channels/cli.ts";
import { EmailChannel } from "./channels/email.ts";
import { emitFeedback, setFeedbackHandler } from "./channels/feedback.ts";
import { formatToolActivity } from "./channels/progress-stream.ts";
import { createProgressStream } from "./channels/progress-stream.ts";
import { ChannelRouter } from "./channels/router.ts";
import { setActionFollowUpHandler } from "./channels/slack-actions.ts";
import { SlackChannel } from "./channels/slack.ts";
import { createStatusReactionController } from "./channels/status-reactions.ts";
import { TelegramChannel } from "./channels/telegram.ts";
import { WebhookChannel } from "./channels/webhook.ts";
import { loadChannelsConfig, loadConfig } from "./config/loader.ts";
import { installShutdownHandlers, onShutdown } from "./core/graceful.ts";
import {
	setChannelHealthProvider,
	setEvolutionVersionProvider,
	setMcpServerProvider,
	setMemoryHealthProvider,
	setOnboardingStatusProvider,
	setPeerHealthProvider,
	setRoleInfoProvider,
	setTriggerDeps,
	setWebhookHandler,
	startServer,
} from "./core/server.ts";
import { closeDatabase, getDatabase } from "./db/connection.ts";
import { runMigrations } from "./db/migrate.ts";
import { createEmailToolServer } from "./email/tool.ts";
import { EvolutionEngine } from "./evolution/engine.ts";
import type { SessionSummary } from "./evolution/types.ts";
import { PeerHealthMonitor } from "./mcp/peer-health.ts";
import { PeerManager } from "./mcp/peers.ts";
import { PhantomMcpServer } from "./mcp/server.ts";
import { loadMemoryConfig } from "./memory/config.ts";
import { type SessionData, consolidateSession, consolidateSessionWithLLM } from "./memory/consolidation.ts";
import { MemoryContextBuilder } from "./memory/context-builder.ts";
import { MemorySystem } from "./memory/system.ts";
import { isFirstRun, isOnboardingInProgress } from "./onboarding/detection.ts";
import { type OnboardingTarget, startOnboarding } from "./onboarding/flow.ts";
import { buildOnboardingPrompt } from "./onboarding/prompt.ts";
import { getOnboardingStatus } from "./onboarding/state.ts";
import { createRoleRegistry } from "./roles/registry.ts";
import type { RoleTemplate } from "./roles/types.ts";
import { Scheduler } from "./scheduler/service.ts";
import { createSchedulerToolServer } from "./scheduler/tool.ts";
import { getSecretRequest } from "./secrets/store.ts";
import { createSecretToolServer } from "./secrets/tools.ts";
import { setPublicDir, setSecretSavedCallback, setSecretsDb } from "./ui/serve.ts";
import { createWebUiToolServer } from "./ui/tools.ts";

async function main(): Promise<void> {
	const startedAt = Date.now();

	console.log("[phantom] Starting...");

	const config = loadConfig();
	console.log(`[phantom] Config loaded: ${config.name} (${config.model}, effort: ${config.effort})`);

	// Set web UI public directory
	setPublicDir(resolve(process.cwd(), "public"));

	// Load role system
	const roleRegistry = createRoleRegistry();
	let activeRole: RoleTemplate | null = null;
	const roleId = config.role;
	if (roleRegistry.has(roleId)) {
		activeRole = roleRegistry.getOrThrow(roleId);
		console.log(`[roles] Loaded role: ${activeRole.name} (${activeRole.id})`);
	} else {
		console.log(`[roles] Role '${roleId}' not found in registry, using config role hint`);
	}

	setRoleInfoProvider(() => (activeRole ? { id: activeRole.id, name: activeRole.name } : null));

	const db = getDatabase();
	runMigrations(db);
	setSecretsDb(db);
	console.log("[phantom] Database ready");

	// Seed working memory file if it does not exist yet
	const wmPath = join(process.cwd(), "data", "working-memory.md");
	if (!existsSync(wmPath)) {
		writeFileSync(wmPath, "# Working Memory\n\nYour personal notes. Update as you learn.\n", "utf-8");
		console.log("[phantom] Seeded working memory file");
	}

	const memoryConfig = loadMemoryConfig();
	const memory = new MemorySystem(memoryConfig);
	await memory.initialize();

	setMemoryHealthProvider(() => memory.healthCheck());

	// Runtime is created before evolution so we can wire it into the engine.
	// Evolution judges run through the same Agent SDK subprocess as the main
	// agent, which means a single auth path and a single provider switch.
	const runtime = new AgentRuntime(config, db);

	let evolution: EvolutionEngine | null = null;
	try {
		evolution = new EvolutionEngine(undefined, runtime);
		const currentVersion = evolution.getCurrentVersion();
		const judgeMode = evolution.usesLLMJudges() ? "LLM judges" : "heuristic";
		console.log(`[evolution] Engine initialized (v${currentVersion}, ${judgeMode})`);
		setEvolutionVersionProvider(() => evolution?.getCurrentVersion() ?? 0);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[evolution] Failed to initialize: ${msg}. Running without self-evolution.`);
	}

	if (activeRole) {
		runtime.setRoleTemplate(activeRole);
	}

	if (memory.isReady()) {
		const contextBuilder = new MemoryContextBuilder(memory, memoryConfig);
		runtime.setMemoryContextBuilder(contextBuilder);
	}

	if (evolution) {
		runtime.setEvolvedConfig(evolution.getConfig());
	}

	// Wire feedback to evolution engine
	setFeedbackHandler((signal) => {
		console.log(`[feedback] ${signal.type} from ${signal.source} (${signal.conversationId})`);
		// Feedback signals feed into the next session's evolution context
		if (evolution) {
			const sessionSummary: SessionSummary = {
				session_id: `feedback_${signal.messageTs}`,
				session_key: signal.conversationId,
				user_id: signal.userId,
				user_messages: [],
				assistant_messages: [],
				tools_used: [],
				files_tracked: [],
				outcome: signal.type === "positive" ? "success" : signal.type === "negative" ? "failure" : "success",
				cost_usd: 0,
				started_at: new Date(signal.timestamp).toISOString(),
				ended_at: new Date(signal.timestamp).toISOString(),
			};
			evolution
				.afterSession(sessionSummary)
				.then((result) => {
					if (result.changes_applied.length > 0) {
						const updatedConfig = evolution?.getConfig();
						if (updatedConfig) runtime.setEvolvedConfig(updatedConfig);
					}
				})
				.catch((err: unknown) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[feedback] Evolution from feedback failed: ${errMsg}`);
				});
		}
	});

	let mcpServer: PhantomMcpServer | null = null;
	let scheduler: Scheduler | null = null;
	try {
		mcpServer = new PhantomMcpServer({
			config,
			db,
			startedAt,
			runtime,
			memory: memory.isReady() ? memory : null,
			evolution,
			roleId: activeRole?.id,
		});
		setMcpServerProvider(() => mcpServer);

		// Wire dynamic tool management tools into the agent as in-process MCP tools
		const registry = mcpServer.getDynamicToolRegistry();

		// Wire scheduler into the agent (Slack channel set later after channel init)
		scheduler = new Scheduler({ db, runtime });

		// Pass factories (not singletons) so each query() gets fresh MCP server instances.
		// The underlying registries (DynamicToolRegistry, Scheduler) are singletons.
		// Only the lightweight McpServer wrappers are recreated per query.
		// This prevents "Already connected to a transport" crashes when the scheduler
		// fires a query while a previous session's transport hasn't fully cleaned up.
		const secretsBaseUrl = config.public_url ?? `http://localhost:${config.port}`;
		runtime.setMcpServerFactories({
			"phantom-dynamic-tools": () => createInProcessToolServer(registry),
			"phantom-scheduler": () => createSchedulerToolServer(scheduler as Scheduler),
			"phantom-web-ui": () => createWebUiToolServer(config.public_url),
			"phantom-secrets": () => createSecretToolServer({ db, baseUrl: secretsBaseUrl }),
			...(process.env.RESEND_API_KEY
				? {
						"phantom-email": () =>
							createEmailToolServer({
								agentName: config.name,
								domain: config.domain ?? "ghostwright.dev",
								dailyLimit: Number(process.env.PHANTOM_EMAIL_DAILY_LIMIT) || 50,
							}),
					}
				: {}),
		});
		const emailStatus = process.env.RESEND_API_KEY ? " + email" : "";
		console.log(
			`[mcp] MCP server initialized (dynamic tools + scheduler + web UI + secrets${emailStatus} wired to agent)`,
		);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[mcp] Failed to initialize MCP server: ${msg}. Running without MCP.`);
	}

	// Peer Phantom connections
	const peerManager = new PeerManager();
	if (config.peers) {
		for (const [name, peerConfig] of Object.entries(config.peers)) {
			if (peerConfig.enabled) {
				peerManager.addPeer(name, peerConfig);
			}
		}
		if (peerManager.count() > 0) {
			console.log(
				`[peers] Loaded ${peerManager.count()} peer(s): ${peerManager
					.getAllPeers()
					.map((p) => p.name)
					.join(", ")}`,
			);
		}
	}

	let peerHealthMonitor: PeerHealthMonitor | null = null;
	if (peerManager.count() > 0) {
		peerHealthMonitor = new PeerHealthMonitor(peerManager);
		peerHealthMonitor.start();
		setPeerHealthProvider(() => peerHealthMonitor?.getHealthSummary() ?? {});
		console.log("[peers] Peer health monitor started");
	}

	const router = new ChannelRouter();

	// Register Slack channel
	let slackChannel: SlackChannel | null = null;
	const channelsConfig = loadChannelsConfig();
	if (channelsConfig?.slack?.enabled && channelsConfig.slack.bot_token && channelsConfig.slack.app_token) {
		slackChannel = new SlackChannel({
			botToken: channelsConfig.slack.bot_token,
			appToken: channelsConfig.slack.app_token,
			defaultChannelId: channelsConfig.slack.default_channel_id,
			ownerUserId: channelsConfig.slack.owner_user_id,
		});
		slackChannel.setPhantomName(config.name);

		// Wire Slack reaction feedback to evolution
		slackChannel.onReaction((event) => {
			emitFeedback({
				type: event.isPositive ? "positive" : "negative",
				conversationId: `slack:${event.channel}:${event.messageTs}`,
				messageTs: event.messageTs,
				userId: event.userId,
				source: "reaction",
				timestamp: Date.now(),
			});
		});

		router.register(slackChannel);
		console.log("[phantom] Slack channel registered");
	}

	// Register Telegram channel
	let telegramChannel: TelegramChannel | null = null;
	if (channelsConfig?.telegram?.enabled && channelsConfig.telegram.bot_token) {
		telegramChannel = new TelegramChannel({
			botToken: channelsConfig.telegram.bot_token,
		});
		router.register(telegramChannel);
		console.log("[phantom] Telegram channel registered");
	}

	// Register Email channel
	let emailChannel: EmailChannel | null = null;
	if (channelsConfig?.email?.enabled) {
		const ec = channelsConfig.email;
		emailChannel = new EmailChannel({
			imap: {
				host: ec.imap.host,
				port: ec.imap.port,
				auth: { user: ec.imap.user, pass: ec.imap.pass },
				tls: ec.imap.tls,
			},
			smtp: {
				host: ec.smtp.host,
				port: ec.smtp.port,
				auth: { user: ec.smtp.user, pass: ec.smtp.pass },
				tls: ec.smtp.tls,
			},
			fromAddress: ec.from_address,
			fromName: ec.from_name,
		});
		router.register(emailChannel);
		console.log("[phantom] Email channel registered");
	}

	// Register Webhook channel
	let webhookChannel: WebhookChannel | null = null;
	if (channelsConfig?.webhook?.enabled && channelsConfig.webhook.secret) {
		webhookChannel = new WebhookChannel({
			secret: channelsConfig.webhook.secret,
			syncTimeoutMs: channelsConfig.webhook.sync_timeout_ms,
		});
		router.register(webhookChannel);
		const wh = webhookChannel;
		setWebhookHandler((req) => wh.handleRequest(req));
		console.log("[phantom] Webhook channel registered");
	}

	// Register CLI channel (fallback for local dev)
	if (!slackChannel && !telegramChannel) {
		const cli = new CliChannel();
		router.register(cli);
	}

	// Wire channel health into HTTP server
	setChannelHealthProvider(() => {
		const health: Record<string, boolean> = {};
		if (slackChannel) health.slack = slackChannel.isConnected();
		if (telegramChannel) health.telegram = telegramChannel.isConnected();
		if (emailChannel) health.email = emailChannel.isConnected();
		if (webhookChannel) health.webhook = webhookChannel.isConnected();
		return health;
	});

	// Wire action follow-up handler (button clicks -> agent)
	setActionFollowUpHandler(async (params) => {
		const followUpText = params.actionPayload
			? `User clicked "${params.actionLabel}". Context: ${params.actionPayload}`
			: `User clicked "${params.actionLabel}". Please follow up accordingly.`;

		await runtime.handleMessage("slack", params.conversationId, followUpText);
	});

	// Onboarding detection
	const configDir = evolution?.getEvolutionConfig().paths.config_dir ?? "phantom-config";
	const needsOnboarding = isFirstRun(configDir) || isOnboardingInProgress(db);
	if (needsOnboarding && activeRole) {
		const onboardingPrompt = buildOnboardingPrompt(activeRole, config.name);
		runtime.setOnboardingPrompt(onboardingPrompt);
		console.log("[onboarding] Onboarding prompt injected into agent runtime");
	}

	setOnboardingStatusProvider(() => getOnboardingStatus(db).status);

	const conversationMessages = new Map<string, { user: string[]; assistant: string[] }>();

	router.onMessage(async (msg) => {
		const sessionStartedAt = new Date().toISOString();
		const convKey = `${msg.channelId}:${msg.conversationId}`;

		const existing = conversationMessages.get(convKey) ?? { user: [], assistant: [] };
		existing.user.push(msg.text);
		conversationMessages.set(convKey, existing);

		const isSlack = msg.channelId === "slack" && slackChannel && msg.metadata;
		const isTelegram = msg.channelId === "telegram" && telegramChannel && msg.metadata;
		const slackChannelId = isSlack ? (msg.metadata?.slackChannel as string) : null;
		const slackThreadTs = isSlack ? (msg.metadata?.slackThreadTs as string) : null;
		const slackMessageTs = isSlack ? (msg.metadata?.slackMessageTs as string) : null;
		const telegramChatId = isTelegram ? (msg.metadata?.telegramChatId as number) : null;

		// Slack: set up status reactions on the user's message
		let statusReactions: ReturnType<typeof createStatusReactionController> | null = null;
		if (isSlack && slackChannel && slackChannelId && slackMessageTs) {
			const sc = slackChannel;
			const ch = slackChannelId;
			const mts = slackMessageTs;
			statusReactions = createStatusReactionController({
				adapter: {
					addReaction: (emoji) => sc.addReaction(ch, mts, emoji),
					removeReaction: (emoji) => sc.removeReaction(ch, mts, emoji),
				},
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[slack] Reaction error: ${errMsg}`);
				},
			});
			statusReactions.setQueued();
		}

		// Slack: set up progress streaming in the thread
		let progressStream: ReturnType<typeof createProgressStream> | null = null;
		if (isSlack && slackChannel && slackChannelId && slackThreadTs) {
			const sc = slackChannel;
			const ch = slackChannelId;
			const tts = slackThreadTs;
			progressStream = createProgressStream({
				adapter: {
					postMessage: (_t) => sc.postThinking(ch, tts).then((ts) => ts ?? ""),
					updateMessage: (msgId, updatedText) => sc.updateMessage(ch, msgId, updatedText),
				},
				onFinish: async (messageId, text) => {
					await sc.updateWithFeedback(ch, messageId, text);
				},
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[slack] Progress stream error: ${errMsg}`);
				},
			});
			await progressStream.start();
		}

		// Telegram: start typing indicator
		if (isTelegram && telegramChannel && telegramChatId) {
			telegramChannel.startTyping(telegramChatId);
		}

		const response = await runtime.handleMessage(msg.channelId, msg.conversationId, msg.text, (event: RuntimeEvent) => {
			switch (event.type) {
				case "init":
					console.log(`\n[phantom] Session: ${event.sessionId}`);
					break;
				case "thinking":
					statusReactions?.setThinking();
					break;
				case "tool_use":
					statusReactions?.setTool(event.tool);
					if (progressStream) {
						const summary = formatToolActivity(event.tool, event.input);
						progressStream.addToolActivity(event.tool, summary);
					}
					break;
				case "error":
					statusReactions?.setError();
					break;
			}
		});

		// Track assistant messages
		if (response.text) {
			existing.assistant.push(response.text);
		}

		// Finalize: set done reaction
		if (response.text.startsWith("Error:")) {
			await statusReactions?.setError();
		} else {
			await statusReactions?.setDone();
		}

		// Telegram: stop typing, send response
		if (isTelegram && telegramChannel && telegramChatId) {
			telegramChannel.stopTyping(telegramChatId);
		}

		// Deliver the response
		if (progressStream) {
			// Slack: update the progress message with the final response + feedback buttons
			await progressStream.finish(response.text);
		} else if (isSlack && slackChannel && slackChannelId && slackThreadTs) {
			// Slack fallback: send direct reply with feedback
			const thinkingTs = await slackChannel.postThinking(slackChannelId, slackThreadTs);
			if (thinkingTs) {
				await slackChannel.updateWithFeedback(slackChannelId, thinkingTs, response.text);
			}
		} else {
			// All other channels: send via router
			await router.send(msg.channelId, msg.conversationId, {
				text: response.text,
				threadId: msg.threadId,
			});
		}

		if (response.cost.totalUsd > 0) {
			console.log(
				`[phantom] Cost: $${response.cost.totalUsd.toFixed(4)} | ` +
					`${response.cost.inputTokens} in / ${response.cost.outputTokens} out | ` +
					`${(response.durationMs / 1000).toFixed(1)}s`,
			);
		}

		const trackedFiles = runtime.getLastTrackedFiles();

		// Memory consolidation (non-blocking)
		if (memory.isReady()) {
			const sessionData: SessionData = {
				sessionId: response.sessionId,
				sessionKey: convKey,
				userId: msg.senderId,
				userMessages: existing.user,
				assistantMessages: existing.assistant,
				toolsUsed: [],
				filesTracked: trackedFiles,
				startedAt: sessionStartedAt,
				endedAt: new Date().toISOString(),
				costUsd: response.cost.totalUsd,
				outcome: response.text.startsWith("Error:") ? "failure" : "success",
			};

			const useLLMConsolidation = evolution?.usesLLMJudges() && evolution.isWithinCostCap();
			if (useLLMConsolidation) {
				const evolvedConfig = evolution?.getConfig();
				const existingFacts = evolvedConfig ? `${evolvedConfig.userProfile}\n${evolvedConfig.domainKnowledge}` : "";
				consolidateSessionWithLLM(runtime, memory, sessionData, existingFacts)
					.then(({ result, judgeCost }) => {
						if (judgeCost) {
							evolution?.trackExternalJudgeCost(judgeCost);
						}
						if (result.episodesCreated > 0 || result.factsExtracted > 0) {
							console.log(
								`[memory] Consolidated (LLM): ${result.episodesCreated} episodes, ` +
									`${result.factsExtracted} facts (${result.durationMs}ms)`,
							);
						}
					})
					.catch((err: unknown) => {
						const errMsg = err instanceof Error ? err.message : String(err);
						console.warn(`[memory] LLM consolidation failed: ${errMsg}`);
					});
			} else {
				consolidateSession(memory, sessionData)
					.then((result) => {
						if (result.episodesCreated > 0 || result.factsExtracted > 0) {
							console.log(
								`[memory] Consolidated: ${result.episodesCreated} episodes, ` +
									`${result.factsExtracted} facts (${result.durationMs}ms)`,
							);
						}
					})
					.catch((err: unknown) => {
						const errMsg = err instanceof Error ? err.message : String(err);
						console.warn(`[memory] Consolidation failed: ${errMsg}`);
					});
			}
		}

		// Evolution pipeline (non-blocking)
		if (evolution) {
			const sessionSummary: SessionSummary = {
				session_id: response.sessionId,
				session_key: convKey,
				user_id: msg.senderId,
				user_messages: existing.user,
				assistant_messages: existing.assistant,
				tools_used: [],
				files_tracked: trackedFiles,
				outcome: response.text.startsWith("Error:") ? "failure" : "success",
				cost_usd: response.cost.totalUsd,
				started_at: sessionStartedAt,
				ended_at: new Date().toISOString(),
			};

			evolution
				.afterSession(sessionSummary)
				.then((result) => {
					if (result.changes_applied.length > 0) {
						const updatedConfig = evolution?.getConfig();
						if (updatedConfig) {
							runtime.setEvolvedConfig(updatedConfig);
						}
					}
				})
				.catch((err: unknown) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[evolution] Post-session evolution failed: ${errMsg}`);
				});
		}

		// Clean up
		statusReactions?.dispose();
	});

	const server = startServer(config, startedAt);

	installShutdownHandlers();
	onShutdown("HTTP server", async () => {
		server.stop();
	});
	onShutdown("MCP server", async () => {
		if (mcpServer) await mcpServer.close();
	});
	onShutdown("Scheduler", async () => {
		if (scheduler) scheduler.stop();
	});
	onShutdown("Peer health monitor", async () => {
		if (peerHealthMonitor) peerHealthMonitor.stop();
	});
	onShutdown("Memory system", async () => {
		await memory.close();
	});
	onShutdown("Channels", async () => {
		await router.disconnectAll();
	});
	onShutdown("Database", async () => {
		closeDatabase();
	});

	await router.connectAll();

	// Wire Slack into scheduler and /trigger now that channels are connected
	if (scheduler && slackChannel && channelsConfig?.slack?.owner_user_id) {
		scheduler.setSlackChannel(slackChannel, channelsConfig.slack.owner_user_id);
	}
	if (scheduler) {
		await scheduler.start();
	}

	// Wire /trigger endpoint
	setTriggerDeps({
		runtime,
		slackChannel: slackChannel ?? undefined,
		ownerUserId: channelsConfig?.slack?.owner_user_id,
	});

	// Wire secret save notification: when the user saves credentials via the form,
	// wake the agent in the original Slack thread so it can respond naturally.
	// This follows the scheduler pattern: route a synthetic message through the runtime.
	setSecretSavedCallback(async (requestId, secretNames) => {
		const request = getSecretRequest(db, requestId);
		if (!request?.notifyChannelId || !request.notifyThread) return;

		const conversationId = `slack:${request.notifyChannelId}:${request.notifyThread}`;
		const prompt = `The user just saved credentials via the secure form: ${secretNames.join(", ")}. Use phantom_get_secret to retrieve them and continue with the task you were working on.`;

		// Non-blocking: wake the agent, let it decide what to say (Cardinal Rule)
		runtime.handleMessage("slack", conversationId, prompt).catch((err: unknown) => {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[secrets] Failed to wake agent after secret save: ${msg}`);
		});
	});

	// Post onboarding intro after channels are connected
	if (isFirstRun(configDir) && activeRole && slackChannel) {
		const ownerUserId = channelsConfig?.slack?.owner_user_id;
		const defaultChannel = channelsConfig?.slack?.default_channel_id;
		const defaultUser = channelsConfig?.slack?.default_user_id;

		// DM the owner first (primary path), fall back to channel or default_user_id
		let target: OnboardingTarget | null = null;
		if (ownerUserId) {
			target = { type: "dm", userId: ownerUserId };
		} else if (defaultUser) {
			target = { type: "dm", userId: defaultUser };
		} else if (defaultChannel) {
			target = { type: "channel", channelId: defaultChannel };
		}

		if (target) {
			const slackClient = slackChannel.getClient();
			const profile = await startOnboarding(slackChannel, target, config.name, activeRole, db, slackClient);

			// Inject owner profile into onboarding prompt for personalized agent conversation
			if (profile && needsOnboarding) {
				const personalizedPrompt = buildOnboardingPrompt(activeRole, config.name, profile);
				runtime.setOnboardingPrompt(personalizedPrompt);
			}

			// Also post to channel if owner DM was sent and channel is configured
			if (target.type === "dm" && defaultChannel) {
				const channelIntro = `Hey team, I'm ${config.name}. I just joined as a ${activeRole.name} co-worker. I'll be working with ${profile?.name ?? "the team"} - feel free to @mention me if you need anything.`;
				await slackChannel.postToChannel(defaultChannel, channelIntro);
				console.log(`[onboarding] Also posted introduction to channel ${defaultChannel}`);
			}
		} else {
			console.warn("[onboarding] No owner, default user, or channel configured, skipping intro message");
		}
	}

	console.log(`[phantom] ${config.name} is ready.`);
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	console.error(`[phantom] Fatal: ${msg}`);
	process.exit(1);
});
