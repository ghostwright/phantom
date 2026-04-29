import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { PhantomConfigSchema } from "../../config/schemas.ts";
import type { PhantomConfig } from "../../config/types.ts";
import { runMigrations } from "../../db/migrate.ts";
import { type AgentSdkQueryParams, type Query, type SDKMessage, __setAgentSdkQueryForTests } from "../agent-sdk.ts";
import { executeChatQuery } from "../chat-query.ts";
import { CostTracker } from "../cost-tracker.ts";
import { runJudgeQuery } from "../judge-query.ts";
import { AgentRuntime } from "../runtime.ts";
import { SessionStore } from "../session-store.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_ID = "22222222-2222-4222-8222-222222222222";
const RESULT_ID = "33333333-3333-4333-8333-333333333333";

function makeConfig(overrides: Record<string, unknown> = {}): PhantomConfig {
	return PhantomConfigSchema.parse({
		name: "phantom",
		model: "claude-opus-4-7",
		judge_model: "claude-sonnet-4-5",
		effort: "max",
		role: "swe",
		port: 3100,
		timeout_minutes: 1,
		max_budget_usd: 0,
		permissions: {
			default_mode: "bypassPermissions",
			allow: [],
			deny: [],
		},
		...overrides,
	});
}

function queryFromMessages(messages: readonly SDKMessage[]): Query {
	async function* iterator(): AsyncGenerator<SDKMessage, void> {
		for (const message of messages) {
			yield message;
		}
	}

	return iterator() as Query;
}

function sdkAssistantUsage(inputTokens: number, outputTokens: number) {
	return {
		cache_creation: null,
		cache_creation_input_tokens: null,
		cache_read_input_tokens: null,
		inference_geo: null,
		input_tokens: inputTokens,
		iterations: null,
		output_tokens: outputTokens,
		server_tool_use: null,
		service_tier: null,
		speed: null,
	};
}

function sdkResultUsage(inputTokens: number, outputTokens: number) {
	return {
		cache_creation: {
			ephemeral_1h_input_tokens: 0,
			ephemeral_5m_input_tokens: 0,
		},
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		inference_geo: "test",
		input_tokens: inputTokens,
		iterations: [],
		output_tokens: outputTokens,
		server_tool_use: {
			web_fetch_requests: 0,
			web_search_requests: 0,
		},
		service_tier: "standard" as const,
		speed: "standard" as const,
	};
}

function initMessage(sessionId = SESSION_ID): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		session_id: sessionId,
		mcp_servers: [],
		tools: [],
		model: "claude-opus-4-7",
		permissionMode: "bypassPermissions",
		slash_commands: [],
		skills: [],
		plugins: [],
		apiKeySource: "user",
		claude_code_version: "test",
		output_style: "default",
		uuid: MESSAGE_ID,
		cwd: "/tmp",
		agents: [],
	} as SDKMessage;
}

function assistantMessage(text: string): SDKMessage {
	return {
		type: "assistant",
		parent_tool_use_id: null,
		session_id: SESSION_ID,
		uuid: MESSAGE_ID,
		message: {
			id: "msg_test",
			container: null,
			role: "assistant",
			content: [{ type: "text", text, citations: null }],
			context_management: null,
			model: "claude-opus-4-7",
			type: "message",
			stop_details: null,
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: sdkAssistantUsage(1, 1),
		},
	} as SDKMessage;
}

function resultMessage(result: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result,
		stop_reason: "end_turn",
		total_cost_usd: 0.01,
		usage: sdkResultUsage(2, 3),
		modelUsage: {},
		permission_denials: [],
		uuid: RESULT_ID,
		session_id: SESSION_ID,
	} as SDKMessage;
}

function noConversationResult(): SDKMessage {
	return {
		type: "result",
		subtype: "error_during_execution",
		errors: ["No conversation found for session stale-session."],
		session_id: "stale-session",
	} as SDKMessage;
}

describe("Agent SDK boundary callers", () => {
	let db: Database;
	let calls: AgentSdkQueryParams[];
	const watchedEnv = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ZAI_API_KEY", "MURPH_PROVIDER"] as const;
	const savedEnv: Record<(typeof watchedEnv)[number], string | undefined> = {
		ANTHROPIC_API_KEY: undefined,
		OPENAI_API_KEY: undefined,
		ZAI_API_KEY: undefined,
		MURPH_PROVIDER: undefined,
	};

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
		calls = [];
		for (const key of watchedEnv) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		__setAgentSdkQueryForTests(null);
		for (const key of watchedEnv) {
			if (savedEnv[key] !== undefined) {
				process.env[key] = savedEnv[key];
			} else {
				delete process.env[key];
			}
		}
		db.close();
	});

	test("AgentRuntime main path runs through the boundary with hooks and MCP servers", async () => {
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([initMessage(), assistantMessage("main assistant"), resultMessage("main result")]);
		});

		const runtime = new AgentRuntime(makeConfig(), db);
		runtime.setMcpServerFactories({ fake: () => ({ type: "stdio", command: "node" }) });

		const response = await runtime.handleMessage("slack", "C1", "hello");
		const options = calls[0]?.options;

		expect(response).toEqual(expect.objectContaining({ text: "main result", sessionId: SESSION_ID }));
		expect(typeof calls[0]?.prompt).toBe("string");
		expect(calls[0]?.prompt).toContain("[SECURITY]");
		expect(options?.persistSession).toBe(true);
		expect(options?.hooks).toBeDefined();
		expect(options?.mcpServers).toEqual({ fake: { type: "stdio", command: "node" } });
	});

	test("AgentRuntime main path passes Murph OpenAI model and native env", async () => {
		process.env.OPENAI_API_KEY = "openai-secret";
		process.env.ANTHROPIC_API_KEY = "stale-anthropic";
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([initMessage(), assistantMessage("main assistant"), resultMessage("main result")]);
		});

		const runtime = new AgentRuntime(
			makeConfig({
				agent_runtime: "murph",
				model: "gpt-5.5",
				provider: { type: "openai" },
			}),
			db,
		);

		await runtime.handleMessage("slack", "C1", "hello");
		const options = calls[0]?.options;

		expect(options?.model).toBe("gpt-5.5");
		expect(options?.env?.MURPH_PROVIDER).toBe("openai");
		expect(options?.env?.MURPH_MODEL).toBe("gpt-5.5");
		expect(options?.env?.MURPH_OPENAI_MODEL).toBe("gpt-5.5");
		expect(options?.env?.OPENAI_API_KEY).toBe("openai-secret");
		expect(options?.env?.ANTHROPIC_API_KEY).toBe("");
	});

	test("chat query path runs through the boundary with chat streaming flags", async () => {
		const sdkEvents: SDKMessage[] = [];
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([initMessage(), assistantMessage("chat assistant"), resultMessage("chat result")]);
		});

		const response = await executeChatQuery(
			{
				config: makeConfig(),
				sessionStore: new SessionStore(db),
				costTracker: new CostTracker(db),
				memoryContextBuilder: null,
				evolvedConfig: null,
				roleTemplate: null,
				onboardingPrompt: null,
				mcpServerFactories: null,
			},
			"web:chat-session",
			{ role: "user", content: "hi" },
			Date.now(),
			{ signal: new AbortController().signal, onSdkEvent: (message) => sdkEvents.push(message) },
		);
		const options = calls[0]?.options;

		expect(response).toEqual(expect.objectContaining({ text: "chat result", sessionId: SESSION_ID }));
		expect(sdkEvents).toHaveLength(3);
		expect(options?.includePartialMessages).toBe(true);
		expect(options?.agentProgressSummaries).toBe(true);
		expect(options?.promptSuggestions).toBe(true);
		expect(options?.hooks).toBeDefined();
	});

	test("chat query path maps Murph Z.AI tier aliases into model and env", async () => {
		process.env.ZAI_API_KEY = "zai-secret";
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([initMessage(), assistantMessage("chat assistant"), resultMessage("chat result")]);
		});

		await executeChatQuery(
			{
				config: makeConfig({
					agent_runtime: "murph",
					model: "sonnet",
					provider: { type: "zai", model_mappings: { sonnet: "glm-5.1" } },
				}),
				sessionStore: new SessionStore(db),
				costTracker: new CostTracker(db),
				memoryContextBuilder: null,
				evolvedConfig: null,
				roleTemplate: null,
				onboardingPrompt: null,
				mcpServerFactories: null,
			},
			"web:chat-session",
			{ role: "user", content: "hi" },
			Date.now(),
			{ signal: new AbortController().signal, onSdkEvent: () => {} },
		);
		const options = calls[0]?.options;

		expect(options?.model).toBe("glm-5.1");
		expect(options?.env?.MURPH_PROVIDER).toBe("glm");
		expect(options?.env?.MURPH_MODEL).toBe("glm-5.1");
		expect(options?.env?.MURPH_GLM_MODEL).toBe("glm-5.1");
		expect(options?.env?.ZAI_API_KEY).toBe("zai-secret");
		expect(options?.env?.ANTHROPIC_BASE_URL).toBe("");
	});

	test("chat query retries stale resume result frames without forwarding the error result", async () => {
		const sdkEvents: SDKMessage[] = [];
		let factoryCalls = 0;
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			if (calls.length === 1) {
				return queryFromMessages([initMessage("stale-session"), noConversationResult()]);
			}
			return queryFromMessages([
				initMessage("fresh-session"),
				assistantMessage("chat assistant"),
				resultMessage("chat result"),
			]);
		});

		const sessionStore = new SessionStore(db);
		sessionStore.create("web", "chat-session");
		sessionStore.updateSdkSessionId("web:chat-session", "stale-session");
		const mcpServerFactories = {
			fake: () => {
				factoryCalls += 1;
				return { type: "stdio" as const, command: `node-${factoryCalls}` };
			},
		};

		const response = await executeChatQuery(
			{
				config: makeConfig(),
				sessionStore,
				costTracker: new CostTracker(db),
				memoryContextBuilder: null,
				evolvedConfig: null,
				roleTemplate: null,
				onboardingPrompt: null,
				mcpServerFactories,
			},
			"web:chat-session",
			{ role: "user", content: "hi" },
			Date.now(),
			{ signal: new AbortController().signal, onSdkEvent: (message) => sdkEvents.push(message) },
		);

		expect(response).toEqual(expect.objectContaining({ text: "chat result", sessionId: "fresh-session" }));
		expect(calls).toHaveLength(2);
		expect(calls[0]?.options?.resume).toBe("stale-session");
		expect(calls[1]?.options?.resume).toBeUndefined();
		expect(factoryCalls).toBe(2);
		expect(calls[0]?.options?.mcpServers).toEqual({ fake: { type: "stdio", command: "node-1" } });
		expect(calls[1]?.options?.mcpServers).toEqual({ fake: { type: "stdio", command: "node-2" } });
		expect(sdkEvents).not.toContainEqual(expect.objectContaining({ subtype: "error_during_execution" }));
	});

	test("judge query path runs through the boundary with stateless judge options", async () => {
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([
				assistantMessage('{"verdict":"pass","confidence":0.9,"reasoning":"ok"}'),
				resultMessage('{"verdict":"pass","confidence":0.9,"reasoning":"ok"}'),
			]);
		});

		const result = await runJudgeQuery(makeConfig(), {
			systemPrompt: "Judge the result.",
			userMessage: "input",
			schema: z.object({
				verdict: z.enum(["pass", "fail"]),
				confidence: z.number(),
				reasoning: z.string(),
			}),
		});
		const options = calls[0]?.options;

		expect(result.verdict).toBe("pass");
		expect(options?.model).toBe("claude-sonnet-4-5");
		expect(options?.persistSession).toBe(false);
		expect(options?.maxTurns).toBe(1);
		expect(options?.permissionMode).toBe("bypassPermissions");
		expect(options?.allowDangerouslySkipPermissions).toBe(true);
	});

	test("judge query path applies exact Murph judge model mappings", async () => {
		process.env.OPENAI_API_KEY = "openai-secret";
		__setAgentSdkQueryForTests((params) => {
			calls.push(params);
			return queryFromMessages([
				assistantMessage('{"verdict":"pass","confidence":0.9,"reasoning":"ok"}'),
				resultMessage('{"verdict":"pass","confidence":0.9,"reasoning":"ok"}'),
			]);
		});

		await runJudgeQuery(
			makeConfig({
				agent_runtime: "murph",
				model: "gpt-5.5",
				judge_model: "haiku",
				provider: { type: "openai", model_mappings: { haiku: "gpt-5.5-mini" } },
			}),
			{
				systemPrompt: "Judge the result.",
				userMessage: "input",
				schema: z.object({
					verdict: z.enum(["pass", "fail"]),
					confidence: z.number(),
					reasoning: z.string(),
				}),
			},
		);
		const options = calls[0]?.options;

		expect(options?.model).toBe("gpt-5.5-mini");
		expect(options?.env?.MURPH_PROVIDER).toBe("openai");
		expect(options?.env?.MURPH_MODEL).toBe("gpt-5.5-mini");
		expect(options?.env?.MURPH_OPENAI_MODEL).toBe("gpt-5.5-mini");
		expect(options?.env?.OPENAI_API_KEY).toBe("openai-secret");
	});
});
