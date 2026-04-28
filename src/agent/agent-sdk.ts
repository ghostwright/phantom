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
import { resolveAgentSdkRuntime } from "./agent-sdk-loader.ts";

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

const defaultRuntime = {
	query: anthropicQuery,
	createSdkMcpServer: anthropicCreateSdkMcpServer,
	tool: anthropicTool,
};
const runtime = await resolveAgentSdkRuntime({ defaultRuntime, env: process.env });

export const createSdkMcpServer = runtime.createSdkMcpServer;
export const tool = runtime.tool;

let activeQuery: AgentSdkQuery = runtime.query;

export function query(params: AgentSdkQueryParams): Query {
	return activeQuery(params);
}

export function __setAgentSdkQueryForTests(queryOverride: AgentSdkQuery | null): void {
	activeQuery = queryOverride ?? runtime.query;
}
