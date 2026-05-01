// Soft permission banner shown after the user sends their first message.
// "Want a ping when your task is done?" with Enable and Dismiss buttons.
// Dismiss hides for 24 hours via localStorage.

import { useBootstrap } from "@/hooks/use-bootstrap";
import { useNotifications } from "@/hooks/use-notifications";
import { Button } from "@/ui/button";
import { BellRing, X } from "lucide-react";
import { useCallback, useState } from "react";

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
  const { data } = useBootstrap();
  const notificationsEnabled = data?.push_notifications_enabled === true;
  const { permission, subscribed, subscribe } = useNotifications({ enabled: notificationsEnabled });
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
    !notificationsEnabled ||
    subscribed ||
    dismissed ||
    permission === "denied" ||
    permission === "unsupported"
  ) {
    return null;
  }

  return (
    <div className="mx-auto mb-3 flex w-full max-w-2xl items-center gap-2 rounded-lg border border-border/70 bg-card/95 px-3 py-2 shadow-sm shadow-black/5">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/40 text-muted-foreground">
        <BellRing className="h-3.5 w-3.5" />
      </span>
      <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        Notify me when long tasks finish.
      </p>
      <Button
        size="sm"
        variant="default"
        onClick={handleEnable}
        disabled={enabling}
        className="h-8 shrink-0"
      >
        {enabling ? "Enabling..." : "Enable"}
      </Button>
      <Button
        size="icon"
        variant="ghost"
        onClick={handleDismiss}
        className="h-8 w-8 shrink-0"
        aria-label="Dismiss notification prompt"
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
