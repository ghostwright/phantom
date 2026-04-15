// Soft permission banner shown after the user sends their first message.
// "Want a ping when your task is done?" with Enable and Dismiss buttons.
// Dismiss hides for 24 hours via localStorage.

import { useCallback, useState } from "react";
import { useNotifications } from "@/hooks/use-notifications";
import { Button } from "@/ui/button";

const DISMISS_KEY = "phantom_notification_banner_dismissed_at";
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

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

export function NotificationBanner({
  visible,
}: {
  visible: boolean;
}) {
  const { permission, subscribed, subscribe } = useNotifications();
  const [dismissed, setDismissed] = useState(isDismissed);
  const [enabling, setEnabling] = useState(false);

  const handleEnable = useCallback(async () => {
    setEnabling(true);
    try {
      await subscribe();
    } finally {
      setEnabling(false);
    }
  }, [subscribe]);

  const handleDismiss = useCallback(() => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable
    }
    setDismissed(true);
  }, []);

  // Hide if: not visible yet, already subscribed, already dismissed,
  // permission denied, or browser doesn't support it
  if (
    !visible ||
    subscribed ||
    dismissed ||
    permission === "denied" ||
    permission === "unsupported"
  ) {
    return null;
  }

  return (
    <div className="mx-auto mb-3 flex w-full max-w-2xl items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      <p className="flex-1 text-sm text-muted-foreground">
        Want a ping when your task is done?
      </p>
      <Button
        size="sm"
        variant="default"
        onClick={handleEnable}
        disabled={enabling}
      >
        {enabling ? "Enabling..." : "Enable"}
      </Button>
      <Button size="sm" variant="ghost" onClick={handleDismiss}>
        Not now
      </Button>
    </div>
  );
}
