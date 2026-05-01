import type { ChatMessage } from "@/lib/chat-types";

export function UserMessage({ message }: { message: ChatMessage }) {
  const text =
    message.content.find((b) => b.type === "text")?.text ?? "";

  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-xl rounded-br-md border border-primary/20 bg-primary/10 px-3.5 py-2.5 text-foreground shadow-sm shadow-black/5">
        <p className="whitespace-pre-wrap text-sm">{text}</p>
      </div>
    </div>
  );
}
