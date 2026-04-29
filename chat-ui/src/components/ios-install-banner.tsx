// iOS Safari install banner. Detects iOS Safari not-standalone mode and
// shows guidance to use Share > Add to Home Screen. Dismissible with
// localStorage persistence (7 days).

import { useCallback, useState } from "react";
import { useBootstrap } from "@/hooks/use-bootstrap";
import { Button } from "@/ui/button";

const DISMISS_KEY = "phantom_ios_install_dismissed_at";
const DISMISS_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) ||
    (ua.includes("Mac") && "ontouchend" in document);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  return isIos && isSafari;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    ("standalone" in navigator && (navigator as Record<string, unknown>).standalone === true)
  );
}

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const dismissedAt = Number(raw);
    return Date.now() - dismissedAt < DISMISS_DURATION_MS;
  } catch {
    return false;
  }
}

export function IosInstallBanner() {
  const [dismissed, setDismissed] = useState(isDismissed);
  const { data, cachedName } = useBootstrap();
  const agentName = data?.agent_name ?? cachedName ?? "this app";

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable
    }
    setDismissed(true);
  }, []);

  if (!isIosSafari() || isStandalone() || dismissed) {
    return null;
  }

  return (
    <div className="mx-auto mb-3 flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <p className="flex-1 text-sm text-muted-foreground">
        Install {agentName} to your home screen for notifications. Tap{" "}
        <svg
          className="inline-block h-4 w-4 align-text-bottom"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 5v14M5 12l7-7 7 7" />
          <rect x="4" y="17" width="16" height="2" rx="1" />
        </svg>{" "}
        Share, then Add to Home Screen.
      </p>
      <Button size="sm" variant="ghost" onClick={handleDismiss}>
        Dismiss
      </Button>
    </div>
  );
}
