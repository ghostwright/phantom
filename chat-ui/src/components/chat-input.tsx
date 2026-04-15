import { ArrowUp, Square } from "lucide-react";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/ui/button";
import type { PendingAttachment } from "@/hooks/use-attachments";
import { AttachmentStrip } from "./attachment-strip";
import { ChatInputToolbar } from "./chat-input-toolbar";

export function ChatInput({
  onSend,
  onStop,
  isStreaming,
  disabled,
  attachments,
  onAddFiles,
  onRemoveFile,
}: {
  onSend: (text: string) => void;
  onStop: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  attachments?: PendingAttachment[];
  onAddFiles?: (files: File[]) => void;
  onRemoveFile?: (id: string) => void;
}) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, isStreaming, onSend]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (composingRef.current) return;
      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  const handlePaperclipClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && onAddFiles) {
        onAddFiles(Array.from(files));
      }
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [onAddFiles],
  );

  const hasAttachments = (attachments?.length ?? 0) > 0;

  return (
    <div className="border-t border-border bg-background px-4 py-3">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-col rounded-xl border border-border bg-card">
          {hasAttachments && attachments && onRemoveFile && (
            <div className="pt-2">
              <AttachmentStrip files={attachments} onRemove={onRemoveFile} />
            </div>
          )}
          <div className="flex items-end gap-2 p-2">
            <ChatInputToolbar onPaperclipClick={handlePaperclipClick} />
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                handleInput();
              }}
              onKeyDown={handleKeyDown}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              placeholder="Send a message..."
              rows={1}
              disabled={disabled}
              enterKeyHint="send"
              className="max-h-[200px] min-h-[36px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
              aria-label="Message input"
              id="chat-composer"
            />
            {isStreaming ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={onStop}
                className="h-8 w-8 shrink-0 rounded-lg bg-destructive text-destructive-foreground hover:bg-destructive/90"
                aria-label="Stop generation"
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                onClick={handleSend}
                disabled={!text.trim() || disabled}
                className="h-8 w-8 shrink-0 rounded-lg bg-primary text-primary-content hover:bg-primary/90 disabled:opacity-50"
                aria-label="Send message"
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={handleFileSelect}
          accept="image/jpeg,image/png,image/gif,image/webp,application/pdf,text/*,.js,.ts,.tsx,.jsx,.py,.go,.rs,.rb,.java,.kt,.swift,.c,.cpp,.h,.hpp,.sh,.bash,.zsh,.toml,.ini,.sql,.json,.md,.csv,.html,.xml,.yaml,.yml"
        />
      </div>
    </div>
  );
}
