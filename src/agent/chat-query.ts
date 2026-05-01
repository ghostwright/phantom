// Extracted chat-specific query logic for the runForChat method.
// Lives outside runtime.ts to keep that file under the 300-line budget.

import { type AgentSdkQueryOptions, type SDKMessage, type SDKUserMessage, query } from "./agent-sdk.ts";

type MessageParam = SDKUserMessage["message"];
import { buildAgentRuntimeEnv, resolveAgentRuntimeModel } from "../config/providers.ts";
import type { PhantomConfig } from "../config/types.ts";
import type { EvolvedConfig } from "../evolution/types.ts";
import type { MemoryContextBuilder } from "../memory/context-builder.ts";
import type { RoleTemplate } from "../roles/types.ts";
import type { CostTracker } from "./cost-tracker.ts";
import { type AgentCost, type AgentResponse, emptyCost } from "./events.ts";
import { createDangerousCommandBlocker, createFileTracker } from "./hooks.ts";
import type { AgentMcpServerFactory } from "./mcp-server-factory.ts";
import { extractTextFromMessageParam } from "./message-param-utils.ts";
import { extractCost, extractTextFromMessage } from "./message-utils.ts";
import { createMurphContextTransform } from "./murph-context.ts";
import { permissionOptionsFromConfig } from "./permission-options.ts";
import { assemblePrompt } from "./prompt-assembler.ts";
import { isNoConversationFoundResult, sdkResultErrorText } from "./sdk-result-errors.ts";
import type { Session, SessionStore } from "./session-store.ts";
import { getThinkingConfig } from "./thinking-config.ts";

export type ChatQueryDeps = {
	config: PhantomConfig;
	sessionStore: SessionStore;
	costTracker: CostTracker;
	memoryContextBuilder: MemoryContextBuilder | null;
	evolvedConfig: EvolvedConfig | null;
	roleTemplate: RoleTemplate | null;
	onboardingPrompt: string | null;
	mcpServerFactories: Record<string, AgentMcpServerFactory> | null;
};

type SessionContextProvider = () => string | undefined;

export async function executeChatQuery(
	deps: ChatQueryDeps,
	sessionKey: string,
	message: MessageParam,
	startTime: number,
	options: {
		signal: AbortSignal;
		onSdkEvent: (msg: SDKMessage) => void;
		sessionContext?: string;
		sessionContextProvider?: SessionContextProvider;
	},
): Promise<AgentResponse> {
	const parts = sessionKey.split(":");
	const channelId = parts[0] ?? "web";
	const conversationId = parts.slice(1).join(":");

	let session: Session | null = deps.sessionStore.findActive(channelId, conversationId);
	const isResume = session?.sdk_session_id != null;
	if (!session) session = deps.sessionStore.create(channelId, conversationId);

	const textForMemory = extractTextFromMessageParam(message);
	let memoryContext: string | undefined;
	if (deps.memoryContextBuilder && textForMemory) {
		try {
			memoryContext = (await deps.memoryContextBuilder.build(textForMemory)) || undefined;
		} catch {
			/* Memory unavailable */
		}
	}
	const useMurphContextTransform = deps.config.agent_runtime === "murph";
	const initialSessionContext = options.sessionContextProvider?.() ?? options.sessionContext;
	const appendPrompt = assemblePrompt(
		deps.config,
		memoryContext,
		deps.evolvedConfig ?? undefined,
		deps.roleTemplate ?? undefined,
		deps.onboardingPrompt ?? undefined,
		undefined,
		useMurphContextTransform ? undefined : initialSessionContext,
	);
	const transformContext = useMurphContextTransform
		? createMurphContextTransform(options.sessionContextProvider ?? initialSessionContext)
		: undefined;
	const queryModel = resolveAgentRuntimeModel(deps.config, deps.config.model);
	const providerEnv = buildAgentRuntimeEnv(deps.config, queryModel);

	const commandBlocker = createDangerousCommandBlocker();
	const fileTracker = createFileTracker();
	const controller = new AbortController();
	const timeoutMs = (deps.config.timeout_minutes ?? 240) * 60 * 1000;
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	options.signal.addEventListener("abort", () => controller.abort(), { once: true });

	let sdkSessionId = "";
	let resultText = "";
	let cost: AgentCost = emptyCost();

	async function* makePrompt(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user" as const,
			message,
			parent_tool_use_id: null,
			session_id: "",
		} as SDKUserMessage;
	}

	const runSdk = async (useResume: boolean): Promise<void> => {
		const permissionOptions = permissionOptionsFromConfig(deps.config);
		const mcpFactoryContext = {
			sessionKey,
			channelId,
			conversationId,
			...(channelId === "web" && conversationId ? { chatSessionId: conversationId } : {}),
		};
		const mcpServers = deps.mcpServerFactories
			? Object.fromEntries(
					await Promise.all(
						Object.entries(deps.mcpServerFactories).map(async ([k, f]) => [k, await f(mcpFactoryContext)] as const),
					),
				)
			: undefined;
		const queryOptions: AgentSdkQueryOptions = {
			model: queryModel,
			...permissionOptions,
			settingSources: ["project", "user"],
			systemPrompt: {
				type: "preset" as const,
				preset: "claude_code" as const,
				append: appendPrompt,
			},
			persistSession: true,
			effort: deps.config.effort,
			thinking: getThinkingConfig(queryModel),
			includePartialMessages: true,
			agentProgressSummaries: true,
			promptSuggestions: true,
			...(deps.config.max_budget_usd > 0 ? { maxBudgetUsd: deps.config.max_budget_usd } : {}),
			abortController: controller,
			env: { ...process.env, ...providerEnv },
			hooks: { PreToolUse: [commandBlocker], PostToolUse: [fileTracker.hook] },
			...(useResume && session?.sdk_session_id ? { resume: session.sdk_session_id } : {}),
			...(mcpServers ? { mcpServers } : {}),
			...(transformContext ? { transformContext } : {}),
		};
		const queryStream = query({
			prompt: makePrompt(),
			options: queryOptions,
		});

		for await (const msg of queryStream) {
			if (isNoConversationFoundResult(msg)) {
				throw new Error(sdkResultErrorText(msg) ?? "No conversation found");
			}
			options.onSdkEvent(msg);
			switch (msg.type) {
				case "system": {
					if ((msg as Record<string, unknown>).subtype === "init") {
						sdkSessionId = (msg as Record<string, unknown>).session_id as string;
						deps.sessionStore.updateSdkSessionId(sessionKey, sdkSessionId);
					}
					break;
				}
				case "assistant": {
					const content = extractTextFromMessage(
						(msg as { message: { content: ReadonlyArray<{ type: string; text?: string }> } }).message,
					);
					if (content) resultText = content;
					break;
				}
				case "result": {
					cost = extractCost(msg as unknown as Parameters<typeof extractCost>[0]);
					const rm = msg as { subtype: string; result?: string };
					if (rm.subtype === "success" && rm.result) resultText = rm.result;
					break;
				}
			}
		}
	};

	try {
		try {
			await runSdk(isResume);
		} catch (err: unknown) {
			if (options.signal.aborted) throw err;
			const errorMsg = err instanceof Error ? err.message : String(err);
			if (isResume && errorMsg.includes("No conversation found")) {
				console.log(`[runtime] Stale chat session, retrying: ${sessionKey}`);
				deps.sessionStore.clearSdkSessionId(sessionKey);
				sdkSessionId = "";
				resultText = "";
				cost = emptyCost();
				await runSdk(false);
			} else {
				throw err;
			}
		}
	} finally {
		clearTimeout(timeout);
	}

	deps.costTracker.record(sessionKey, cost, queryModel);
	deps.sessionStore.touch(sessionKey);

	return { text: resultText, sessionId: sdkSessionId, cost, durationMs: Date.now() - startTime };
}
