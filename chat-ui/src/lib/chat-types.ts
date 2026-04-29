// Client-side types for chat state management.
// Compatible with but not imported from the server-side wire format types.

export type ChatToolStateValue =
  | "pending"
  | "input_streaming"
  | "input_complete"
  | "running"
  | "result"
  | "error"
  | "aborted"
  | "blocked";

export type ContentBlock = {
  type: string;
  text?: string;
  blockId?: string;
  [key: string]: unknown;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: ContentBlock[];
  createdAt: string;
  status: "committed" | "streaming" | "error";
  stopReason?: string | null;
  costUsd?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
};

export type ToolCallState = {
  id: string;
  messageId: string;
  toolName: string;
  state: ChatToolStateValue;
  inputJson: string;
  input?: unknown;
  output?: string;
  error?: string;
  durationMs?: number;
  elapsedSeconds?: number;
  outputTruncated?: boolean;
  isMcp: boolean;
  mcpServer?: string;
  blockReason?: string;
};

export type ThinkingBlockState = {
  messageId: string;
  text: string;
  redacted: boolean;
  isStreaming: boolean;
  durationMs?: number;
};

export type TextBlockState = {
  messageId: string;
  text: string;
};

export type ChatState = {
  messages: ChatMessage[];
  activeToolCalls: Map<string, ToolCallState>;
  thinkingBlocks: Map<string, ThinkingBlockState>;
  textBlocks: Map<string, TextBlockState>;
  isStreaming: boolean;
  lastSeq: number;
  sessionId: string | null;
};
