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
	SDKMessage,
	SDKSystemMessage,
	SDKUserMessage,
};

export const createSdkMcpServer = anthropicCreateSdkMcpServer;
export const query = anthropicQuery;
export const tool = anthropicTool;
