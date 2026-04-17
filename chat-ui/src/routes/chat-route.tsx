import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EmptyState } from "@/components/empty-state";
import { ChatInput } from "@/components/chat-input";
import { createSession } from "@/lib/client";

const PREFILL_MAX = 2000;

// The landing page deep-links here as `/chat?prefill=<urlencoded>` to seed the
// composer with a starter prompt. We decode, cap at 2000 chars, strip the
// query param from the URL, and render. The user still has to hit Send; this
// is a consent surface, not an auto-run.
function readPrefill(): string | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("prefill");
  if (raw === null) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  if (decoded.length > PREFILL_MAX) {
    console.warn(
      `[chat] prefill truncated from ${decoded.length} to ${PREFILL_MAX} chars`,
    );
    decoded = decoded.slice(0, PREFILL_MAX - 1) + "\u2026";
  }
  return decoded;
}

export function ChatRoute() {
  const navigate = useNavigate();
  const creatingRef = useRef(false);
  const [initialText, setInitialText] = useState<string | undefined>(undefined);

  useEffect(() => {
    const prefill = readPrefill();
    if (prefill === null) return;
    setInitialText(prefill);
    window.history.replaceState({}, "", "/chat");
  }, []);

  const handleCreateAndNavigate = useCallback(
    async (text: string) => {
      if (creatingRef.current) return;
      creatingRef.current = true;
      try {
        const result = await createSession();
        navigate(`/s/${result.id}`, { state: { initialMessage: text } });
      } finally {
        creatingRef.current = false;
      }
    },
    [navigate],
  );

  return (
    <>
      <EmptyState onSuggestionClick={handleCreateAndNavigate} />
      <ChatInput
        onSend={handleCreateAndNavigate}
        onStop={() => {}}
        isStreaming={false}
        initialText={initialText}
      />
    </>
  );
}
