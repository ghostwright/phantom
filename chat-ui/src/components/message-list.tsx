import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { ACTIVE_RUN_MESSAGE_ID } from "@/lib/chat-activity";
import type { ChatMessage, RunActivityState, ThinkingBlockState, ToolCallState } from "@/lib/chat-types";
import { Button } from "@/ui/button";
import { ArrowDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ThinkingBlockItem } from "./assistant-message";
import { Message } from "./message";
import { MessageActions } from "./message-actions";
import { RunActivityRow } from "./run-activity-row";

export function MessageList({
	messages,
	activeToolCalls,
	thinkingBlocks,
	runActivity,
	isStreaming,
}: {
	messages: ChatMessage[];
	activeToolCalls: Map<string, ToolCallState>;
	thinkingBlocks: Map<string, ThinkingBlockState>;
	runActivity: RunActivityState | null;
	isStreaming?: boolean;
}) {
	const { containerRef, isAtBottom, scrollToBottom } = useAutoScroll();
	const [liveText, setLiveText] = useState("");
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const toolCallsByMessage = useMemo(() => {
		const map = new Map<string, ToolCallState[]>();
		for (const [, tc] of activeToolCalls) {
			const existing = map.get(tc.messageId) ?? [];
			existing.push(tc);
			map.set(tc.messageId, existing);
		}
		return map;
	}, [activeToolCalls]);

	const thinkingByMessage = useMemo(() => {
		const map = new Map<string, ThinkingBlockItem[]>();
		for (const [id, tb] of thinkingBlocks) {
			const existing = map.get(tb.messageId) ?? [];
			existing.push({ id, block: tb });
			map.set(tb.messageId, existing);
		}
		return map;
	}, [thinkingBlocks]);

	// Debounced aria-live updates during streaming
	useEffect(() => {
		if (!isStreaming) {
			setLiveText("");
			return;
		}

		const lastMsg = messages[messages.length - 1];
		if (!lastMsg || lastMsg.role !== "assistant") return;

		const fullText = lastMsg.content
			.filter((b) => b.type === "text")
			.map((b) => b.text ?? "")
			.join("");

		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			// Only announce the last 200 chars to avoid overwhelming screen readers
			const tail = fullText.length > 200 ? fullText.slice(-200) : fullText;
			setLiveText(tail);
		}, 1000);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [messages, isStreaming]);

	return (
		<div className="relative flex-1 overflow-hidden">
			<div ref={containerRef} className="h-full overflow-y-auto px-4 py-4">
				<div className="mx-auto max-w-3xl space-y-4">
					{messages.map((message) => (
						<div key={message.id} className="group relative">
							<Message
								message={message}
								toolCalls={toolCallsByMessage.get(message.id) ?? []}
								thinkingBlocks={thinkingByMessage.get(message.id) ?? []}
							/>
							{message.role === "assistant" && <MessageActions message={message} />}
							{message.runTimeline && (
								<RunActivityRow activity={message.runTimeline.activity} toolCalls={message.runTimeline.toolCalls} />
							)}
						</div>
					))}
					{runActivity && (
						<RunActivityRow activity={runActivity} toolCalls={toolCallsByMessage.get(ACTIVE_RUN_MESSAGE_ID) ?? []} />
					)}
				</div>
			</div>

			{!isAtBottom && (
				<div className="absolute bottom-4 left-1/2 -translate-x-1/2">
					<Button variant="outline" size="sm" onClick={() => scrollToBottom()} className="gap-1 shadow-md">
						<ArrowDown className="h-3.5 w-3.5" />
						Jump to bottom
					</Button>
				</div>
			)}

			{/* Screen reader announcements for streaming */}
			<div className="sr-only" aria-live="polite" aria-atomic="true">
				{isStreaming ? "Agent is working..." : ""}
			</div>
			<div className="sr-only" aria-live="polite" aria-atomic="false">
				{liveText}
			</div>
		</div>
	);
}
