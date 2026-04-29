import { Check, Copy } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/ui/button";
import type { ChatMessage } from "@/lib/chat-types";

export function MessageActions({ message }: { message: ChatMessage }) {
  const [copied, setCopied] = useState(false);

  const textContent =
    message.content.find((b) => b.type === "text")?.text ?? "";

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }, [textContent]);

  if (!textContent || message.status === "streaming") return null;

  return (
    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        onClick={handleCopy}
        aria-label="Copy message"
      >
        {copied ? (
          <Check className="h-3 w-3 text-success" />
        ) : (
          <Copy className="h-3 w-3" />
        )}
      </Button>
    </div>
  );
}
