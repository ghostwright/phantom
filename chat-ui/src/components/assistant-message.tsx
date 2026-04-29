import type { ChatMessage, ThinkingBlockState, ToolCallState } from "@/lib/chat-types";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { ToolCallCard } from "./tool-call-card";

export function AssistantMessage({
  message,
  toolCalls,
  thinkingBlocks,
}: {
  message: ChatMessage;
  toolCalls: ToolCallState[];
  thinkingBlocks: ThinkingBlockState[];
}) {
  const textContent =
    message.content.find((b) => b.type === "text")?.text ?? "";

  const isStreaming = message.status === "streaming";

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%]">
        {thinkingBlocks.map((block, i) => (
          <ThinkingBlock key={`thinking-${i}`} block={block} />
        ))}

        {toolCalls.map((tool) => (
          <ToolCallCard key={tool.id} tool={tool} />
        ))}

        {textContent && <Markdown content={textContent} />}

        {isStreaming && !textContent && toolCalls.length === 0 && (
          <div className="flex items-center gap-1.5 py-2">
            <div className="h-2 w-2 animate-pulse rounded-full bg-primary" />
            <div className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:150ms]" />
            <div className="h-2 w-2 animate-pulse rounded-full bg-primary [animation-delay:300ms]" />
          </div>
        )}

        {message.costUsd != null && message.status === "committed" && (
          <div className="mt-1 text-xs text-muted-foreground">
            {message.inputTokens != null && message.outputTokens != null && (
              <span>
                {message.inputTokens.toLocaleString()} in /{" "}
                {message.outputTokens.toLocaleString()} out
              </span>
            )}
            {message.costUsd > 0 && (
              <span className="ml-2">
                ${message.costUsd.toFixed(4)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
