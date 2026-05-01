import type { ThinkingBlockState } from "@/lib/chat-types";
import { Brain } from "lucide-react";

export function ThinkingBlock({ block }: { block: ThinkingBlockState }) {
	const durationText = block.durationMs
		? `Thought for ${(block.durationMs / 1000).toFixed(1)}s`
		: block.isStreaming
			? "Thinking..."
			: "Thought";

	return (
		<div className="my-2 flex items-center gap-2 text-sm text-muted-foreground">
			<Brain className={block.isStreaming ? "h-4 w-4 shrink-0 animate-pulse text-primary" : "h-4 w-4 shrink-0"} />
			<span>{block.redacted ? "Reasoning hidden" : durationText}</span>
		</div>
	);
}
