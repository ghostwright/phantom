import { useSyncExternalStore } from "react";

const STORAGE_KEY = "phantom-chat-theme";

type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// Singleton store. Without this, two components that call useTheme()
// hold independent copies of the state, so a toggle in AppShell never
// reaches the Toaster wrapper. useSyncExternalStore subscribes every
// consumer to the same source so every caller stays in lockstep.
let currentTheme: Theme = getInitialTheme();
if (typeof window !== "undefined") applyTheme(currentTheme);

const subscribers = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

function getSnapshot(): Theme {
  return currentTheme;
}

function setTheme(next: Theme): void {
  if (currentTheme === next) return;
  currentTheme = next;
  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
  }
  notifySubscribers();
}

export function useTheme(): {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
} {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    theme,
    setTheme,
    toggleTheme: () => setTheme(theme === "dark" ? "light" : "dark"),
  };
}
