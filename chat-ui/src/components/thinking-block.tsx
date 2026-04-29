import { Brain, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { ThinkingBlockState } from "@/lib/chat-types";

export function ThinkingBlock({ block }: { block: ThinkingBlockState }) {
  const [isOpen, setIsOpen] = useState(block.isStreaming);
  const wasStreamingRef = useRef(block.isStreaming);

  // Auto-open when streaming starts, auto-close when it ends
  useEffect(() => {
    if (block.isStreaming && !wasStreamingRef.current) {
      setIsOpen(true);
    }
    if (!block.isStreaming && wasStreamingRef.current) {
      const timer = setTimeout(() => setIsOpen(false), 1000);
      return () => clearTimeout(timer);
    }
    wasStreamingRef.current = block.isStreaming;
  }, [block.isStreaming]);

  const durationText = block.durationMs
    ? `Thought for ${(block.durationMs / 1000).toFixed(1)}s`
    : block.isStreaming
      ? "Thinking..."
      : "Thought";

  if (block.redacted) {
    return (
      <div className="my-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
        <Brain className="h-4 w-4 shrink-0" />
        <span>[Thinking was redacted]</span>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <Brain
          className={cn(
            "h-4 w-4 shrink-0",
            block.isStreaming && "animate-pulse text-primary",
          )}
        />
        <span className="flex-1 text-left">{durationText}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 transition-transform",
            isOpen && "rotate-180",
          )}
        />
      </button>
      {isOpen && (
        <div className="border-t border-border px-3 py-2">
          <p className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {block.text}
          </p>
        </div>
      )}
    </div>
  );
}
