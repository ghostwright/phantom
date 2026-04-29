import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useAttachments } from "@/hooks/use-attachments";
import { useChat } from "@/hooks/use-chat";
import { useDragDrop } from "@/hooks/use-drag-drop";
import { useFocusHeartbeat } from "@/hooks/use-focus-heartbeat";
import { usePaste } from "@/hooks/use-paste";
import { ChatInput } from "@/components/chat-input";
import { DropOverlay } from "@/components/drop-overlay";
import { MessageList } from "@/components/message-list";
import { NotificationBanner } from "@/components/notification-banner";
import { IosInstallBanner } from "@/components/ios-install-banner";

export function SessionRoute() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const {
    messages,
    activeToolCalls,
    thinkingBlocks,
    isStreaming,
    sendMessage,
    abort,
    loadSession,
  } = useChat(sessionId ?? null);

  const { files, addFiles, removeFile, clearFiles, uploadFiles, isUploading } =
    useAttachments();

  const { isDragging, dropRef } = useDragDrop(addFiles);
  usePaste(addFiles);
  useFocusHeartbeat(sessionId ?? null);

  const [hasSentMessage, setHasSentMessage] = useState(false);
  const sentCountRef = useRef(0);

  useEffect(() => {
    clearFiles();
    const state = location.state as { initialMessage?: string } | null;
    if (sessionId && !state?.initialMessage) {
      loadSession(sessionId);
    }
  }, [sessionId, loadSession, location.state, clearFiles]);

  useEffect(() => {
    // Listen for the Cmd+. stop shortcut dispatched from AppShell. Only
    // abort when a stream is actually in flight so the shortcut stays
    // idempotent on an idle session.
    const onStop = (): void => {
      if (isStreaming) abort();
    };
    window.addEventListener("phantom:stop-generation", onStop);
    return () => window.removeEventListener("phantom:stop-generation", onStop);
  }, [isStreaming, abort]);

  useEffect(() => {
    const state = location.state as { initialMessage?: string } | null;
    if (state?.initialMessage && sessionId) {
      sendMessage(state.initialMessage);
      sentCountRef.current++;
      setHasSentMessage(true);
      window.history.replaceState({}, "", location.pathname);
    }
  }, [sessionId, location.state, location.pathname, sendMessage]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!sessionId) return;
      const attachmentIds = await uploadFiles(sessionId);
      if (attachmentIds.length > 0) clearFiles();
      sendMessage(text, attachmentIds.length > 0 ? attachmentIds : undefined);
      sentCountRef.current++;
      setHasSentMessage(true);
    },
    [sessionId, uploadFiles, clearFiles, sendMessage],
  );

  return (
    <div ref={dropRef} className="flex min-h-0 flex-1 flex-col">
      <MessageList
        messages={messages}
        activeToolCalls={activeToolCalls}
        thinkingBlocks={thinkingBlocks}
        isStreaming={isStreaming}
      />
      <NotificationBanner visible={hasSentMessage} />
      <IosInstallBanner />
      <ChatInput
        onSend={handleSend}
        onStop={abort}
        isStreaming={isStreaming}
        disabled={isUploading}
        attachments={files}
        onAddFiles={addFiles}
        onRemoveFile={removeFile}
      />
      <DropOverlay visible={isDragging} />
    </div>
  );
}
