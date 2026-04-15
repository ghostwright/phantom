import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { useChat } from "@/hooks/use-chat";
import { useFocusHeartbeat } from "@/hooks/use-focus-heartbeat";
import { ChatInput } from "@/components/chat-input";
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

  useFocusHeartbeat(sessionId ?? null);

  // Track whether the user has sent at least one message in this session
  const [hasSentMessage, setHasSentMessage] = useState(false);
  const sentCountRef = useRef(0);

  useEffect(() => {
    const state = location.state as { initialMessage?: string } | null;
    if (sessionId && !state?.initialMessage) {
      loadSession(sessionId);
    }
  }, [sessionId, loadSession, location.state]);

  // Handle initial message passed from the welcome state
  useEffect(() => {
    const state = location.state as { initialMessage?: string } | null;
    if (state?.initialMessage && sessionId) {
      sendMessage(state.initialMessage);
      sentCountRef.current++;
      setHasSentMessage(true);
      // Clear the state so it doesn't re-fire
      window.history.replaceState({}, "", location.pathname);
    }
  }, [sessionId, location.state, location.pathname, sendMessage]);

  const handleSend = useCallback(
    (text: string) => {
      sendMessage(text);
      sentCountRef.current++;
      setHasSentMessage(true);
    },
    [sendMessage],
  );

  return (
    <>
      <MessageList
        messages={messages}
        activeToolCalls={activeToolCalls}
        thinkingBlocks={thinkingBlocks}
      />
      <NotificationBanner visible={hasSentMessage} />
      <IosInstallBanner />
      <ChatInput
        onSend={handleSend}
        onStop={abort}
        isStreaming={isStreaming}
      />
    </>
  );
}
