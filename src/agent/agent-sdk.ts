// Single integration boundary for the Claude Agent SDK. Keep direct package
// imports here so runtime swaps and compatibility tests have one place to land.

import {
	createSdkMcpServer as anthropicCreateSdkMcpServer,
	query as anthropicQuery,
	tool as anthropicTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
	HookCallbackMatcher,
	HookInput,
	HookJSONOutput,
	McpSdkServerConfigWithInstance,
	McpServerConfig,
	Query,
	SDKMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

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

export const createSdkMcpServer = anthropicCreateSdkMcpServer;
export const tool = anthropicTool;

export type AgentSdkQueryParams = Parameters<typeof anthropicQuery>[0];
export type AgentSdkQuery = (params: AgentSdkQueryParams) => Query;

let activeQuery: AgentSdkQuery = anthropicQuery;

export function query(params: AgentSdkQueryParams): Query {
	return activeQuery(params);
}

export function __setAgentSdkQueryForTests(queryOverride: AgentSdkQuery | null): void {
	activeQuery = queryOverride ?? anthropicQuery;
}
