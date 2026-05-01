import type { McpServerConfig } from "./agent-sdk.ts";

export type AgentMcpServerFactoryContext = {
	sessionKey: string;
	channelId: string;
	conversationId: string;
	chatSessionId?: string;
};

export type AgentMcpServerFactory = (
	context?: AgentMcpServerFactoryContext,
) => McpServerConfig | Promise<McpServerConfig>;
