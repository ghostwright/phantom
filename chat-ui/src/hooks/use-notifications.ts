import { useCallback, useEffect, useRef, useState } from "react";

type NotificationState = {
  permission: NotificationPermission | "unsupported";
  subscribed: boolean;
  swRegistration: ServiceWorkerRegistration | null;
};

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function useNotifications(): {
  permission: NotificationState["permission"];
  subscribed: boolean;
  subscribe: () => Promise<boolean>;
  unsubscribe: () => Promise<void>;
} {
  const [state, setState] = useState<NotificationState>({
    permission:
      typeof Notification !== "undefined"
        ? Notification.permission
        : "unsupported",
    subscribed: false,
    swRegistration: null,
  });
  const vapidKeyRef = useRef<string | null>(null);

  // Register Service Worker on mount
  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState((s) => ({ ...s, permission: "unsupported" }));
      return;
    }

    navigator.serviceWorker
      .register("/chat/sw.js", { scope: "/chat/" })
      .then((reg) => {
        setState((s) => ({ ...s, swRegistration: reg }));

        // Check existing subscription
        reg.pushManager.getSubscription().then((sub) => {
          if (sub) {
            setState((s) => ({ ...s, subscribed: true }));
          }
        });
      })
      .catch((err) => {
        console.warn("[notifications] SW registration failed:", err);
      });

    // Fetch VAPID key
    fetch("/chat/push/vapid-key", { credentials: "include" })
      .then((res) => {
        if (res.ok) return res.json();
        return null;
      })
      .then((data: { publicKey: string } | null) => {
        if (data?.publicKey) {
          vapidKeyRef.current = data.publicKey;
        }
      })
      .catch(() => {});
  }, []);

  const subscribe = useCallback(async (): Promise<boolean> => {
    if (!state.swRegistration || !vapidKeyRef.current) return false;

    try {
      const permission = await Notification.requestPermission();
      setState((s) => ({ ...s, permission }));

      if (permission !== "granted") return false;

      const sub = await state.swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKeyRef.current).buffer as ArrayBuffer,
      });

      const subJson = sub.toJSON();
      if (!subJson.keys?.p256dh || !subJson.keys?.auth) return false;

      const res = await fetch("/chat/push/subscribe", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: sub.endpoint,
          p256dh: subJson.keys.p256dh,
          auth: subJson.keys.auth,
          userAgent: navigator.userAgent,
        }),
      });

      if (res.ok) {
        setState((s) => ({ ...s, subscribed: true }));
        return true;
      }
      return false;
    } catch (err) {
      console.warn("[notifications] Subscribe failed:", err);
      return false;
    }
  }, [state.swRegistration]);

  const unsubscribe = useCallback(async (): Promise<void> => {
    if (!state.swRegistration) return;

    try {
      const sub = await state.swRegistration.pushManager.getSubscription();
      if (sub) {
        await fetch("/chat/push/subscribe", {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState((s) => ({ ...s, subscribed: false }));
    } catch (err) {
      console.warn("[notifications] Unsubscribe failed:", err);
    }
  }, [state.swRegistration]);

  return {
    permission: state.permission,
    subscribed: state.subscribed,
    subscribe,
    unsubscribe,
  };
}
