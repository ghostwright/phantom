import type { ChatMessage } from "@/lib/chat-types";

export function UserMessage({ message }: { message: ChatMessage }) {
  const text =
    message.content.find((b) => b.type === "text")?.text ?? "";

  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-content">
        <p className="whitespace-pre-wrap text-sm">{text}</p>
      </div>
    </div>
  );
}
