import { extractToolArtifacts } from "@/lib/chat-artifacts";
import { getAssistantTextBlocks } from "@/lib/chat-message-content";
import type { ChatMessage, ThinkingBlockState, ToolCallState } from "@/lib/chat-types";
import { ArtifactTray } from "./artifact-tray";
import { Markdown } from "./markdown";
import { ThinkingBlock } from "./thinking-block";
import { ToolCallCard } from "./tool-call-card";

export type ThinkingBlockItem = {
	id: string;
	block: ThinkingBlockState;
};

export function AssistantMessage({
	message,
	toolCalls,
	thinkingBlocks,
}: {
	message: ChatMessage;
	toolCalls: ToolCallState[];
	thinkingBlocks: ThinkingBlockItem[];
}) {
	const textBlocks = getAssistantTextBlocks(message);
	const artifacts = extractToolArtifacts(toolCalls);
	const hasText = textBlocks.length > 0;

	const isStreaming = message.status === "streaming";

	return (
		<div className="flex justify-start">
			<div className="max-w-[92%]">
				{thinkingBlocks.map((item) => (
					<ThinkingBlock key={item.id} block={item.block} />
				))}

				{toolCalls.map((tool) => (
					<ToolCallCard key={tool.id} tool={tool} />
				))}

				{textBlocks.map((textContent) => (
					<Markdown key={`text-${hashText(textContent)}`} content={textContent} />
				))}

				<ArtifactTray artifacts={artifacts} />

				{isStreaming && !hasText && toolCalls.length === 0 && (
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
								{message.inputTokens.toLocaleString()} in / {message.outputTokens.toLocaleString()} out
							</span>
						)}
						{message.costUsd > 0 && <span className="ml-2">${message.costUsd.toFixed(4)}</span>}
					</div>
				)}
			</div>
		</div>
	);
}

function hashText(value: string): string {
	let hash = 0;
	for (let i = 0; i < value.length; i += 1) {
		hash = (hash * 31 + value.charCodeAt(i)) | 0;
	}
	return Math.abs(hash).toString(36);
}
