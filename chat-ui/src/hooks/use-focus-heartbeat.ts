import { useEffect } from "react";

export function useFocusHeartbeat(sessionId: string | null): void {
  useEffect(() => {
    if (!sessionId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    function sendHeartbeat(focused: boolean): void {
      fetch("/chat/focus", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, focused }),
      }).catch(() => {});
    }

    function onVisibilityChange(): void {
      sendHeartbeat(document.visibilityState === "visible");
    }

    sendHeartbeat(true);
    intervalId = setInterval(() => {
      if (document.visibilityState === "visible") {
        sendHeartbeat(true);
      }
    }, 10_000);

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      sendHeartbeat(false);
    };
  }, [sessionId]);
}
