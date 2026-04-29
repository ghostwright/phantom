// Single integration boundary for the Claude Agent SDK. Keep direct package
// imports here so runtime swaps and compatibility tests have one place to land.

import {
	createSdkMcpServer as anthropicCreateSdkMcpServer,
	query as anthropicQuery,
	tool as anthropicTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	AnyZodRawShape,
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	McpSdkServerConfigWithInstance,
	McpServerConfig,
	Query,
	SDKMessage,
	SDKSystemMessage,
	SDKUserMessage,
	SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { type AgentRuntimeKind, resolveAgentSdkRuntime } from "./agent-sdk-loader.ts";

export type {
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	McpSdkServerConfigWithInstance,
	McpServerConfig,
	Query,
	SDKMessage,
	SDKSystemMessage,
	SDKUserMessage,
};

export type AgentSdkQueryParams = Parameters<typeof anthropicQuery>[0];
export type AgentSdkQuery = (params: AgentSdkQueryParams) => Query;
export type AgentSdkRuntimeSelection = {
	agentRuntime: AgentRuntimeKind;
	env?: Record<string, string | undefined>;
};
type AgentSdkToolExtras = {
	annotations?: ToolAnnotations;
	searchHint?: string;
};

const defaultRuntime = {
	query: anthropicQuery,
	createSdkMcpServer: anthropicCreateSdkMcpServer,
	tool: anthropicTool,
};
let activeRuntime = await resolveAgentSdkRuntime({ defaultRuntime, env: process.env });
let activeQuery: AgentSdkQuery = activeRuntime.query;

export function createSdkMcpServer(
	...args: Parameters<typeof anthropicCreateSdkMcpServer>
): ReturnType<typeof anthropicCreateSdkMcpServer> {
	return activeRuntime.createSdkMcpServer(...args);
}

export function tool<Schema extends AnyZodRawShape>(
	name: string,
	description: string,
	inputSchema: Schema,
	handler: SdkMcpToolDefinition<Schema>["handler"],
	extras?: AgentSdkToolExtras,
): SdkMcpToolDefinition<Schema> {
	return activeRuntime.tool(name, description, inputSchema, handler, extras);
}

export function query(params: AgentSdkQueryParams): Query {
	return activeQuery(params);
}

export async function configureAgentSdkRuntime(input: AgentSdkRuntimeSelection): Promise<void> {
	activeRuntime = await resolveAgentSdkRuntime({
		defaultRuntime,
		agentRuntime: input.agentRuntime,
		env: input.env,
	});
	activeQuery = activeRuntime.query;
}

export function __setAgentSdkQueryForTests(queryOverride: AgentSdkQuery | null): void {
	activeQuery = queryOverride ?? activeRuntime.query;
}
