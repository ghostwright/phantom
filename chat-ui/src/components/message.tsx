import type { ChatMessage, ThinkingBlockState, ToolCallState } from "@/lib/chat-types";
import { AssistantMessage } from "./assistant-message";
import { UserMessage } from "./user-message";

export function Message({
  message,
  toolCalls,
  thinkingBlocks,
}: {
  message: ChatMessage;
  toolCalls: ToolCallState[];
  thinkingBlocks: ThinkingBlockState[];
}) {
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }

  return (
    <AssistantMessage
      message={message}
      toolCalls={toolCalls}
      thinkingBlocks={thinkingBlocks}
    />
  );
}
