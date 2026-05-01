import type { ChatMessage } from "@/lib/chat-types";
import { File, FileText } from "lucide-react";

export function UserMessage({ message }: { message: ChatMessage }) {
  const text =
    message.content.find((b) => b.type === "text")?.text ?? "";
  const attachments = message.attachments ?? [];

  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-xl rounded-br-md border border-primary/20 bg-primary/10 px-3.5 py-2.5 text-foreground shadow-sm shadow-black/5">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((attachment) => (
              <a
                key={attachment.id}
                href={attachment.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="flex max-w-full items-center gap-1.5 rounded-md border border-primary/15 bg-background/70 px-2 py-1 text-xs text-foreground shadow-sm transition-colors hover:bg-background"
                title={attachment.filename}
              >
                <AttachmentIcon mimeType={attachment.mimeType} previewUrl={attachment.previewUrl} filename={attachment.filename} />
                <span className="min-w-0 max-w-[12rem] truncate">{attachment.filename}</span>
                {attachment.sizeBytes != null && (
                  <span className="shrink-0 text-muted-foreground">{formatBytes(attachment.sizeBytes)}</span>
                )}
              </a>
            ))}
          </div>
        )}
        {text && <p className="whitespace-pre-wrap text-sm">{text}</p>}
      </div>
    </div>
  );
}

function AttachmentIcon({
	mimeType,
	previewUrl,
	filename,
}: {
	mimeType: string;
	previewUrl: string;
	filename: string;
}) {
	if (mimeType.startsWith("image/")) {
		return (
			<span className="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-muted">
				<img src={previewUrl} alt={filename} className="h-full w-full object-cover" />
			</span>
		);
	}
	if (mimeType === "application/pdf") {
		return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
	}
	if (mimeType.startsWith("text/") || mimeType === "application/json") {
		return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
	}
	return <File className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
