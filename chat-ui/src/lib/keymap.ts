// Keyboard shortcut definitions.
// Single source of truth for all keybindings.

export type Shortcut = {
  key: string;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  label: string;
  description: string;
  category: "global" | "composer" | "sidebar" | "message";
};

export const shortcuts: Record<string, Shortcut> = {
  newSession: {
    key: "o",
    meta: true,
    shift: true,
    label: "New conversation",
    description: "Start a new conversation",
    category: "global",
  },
  stopGeneration: {
    key: ".",
    meta: true,
    label: "Stop",
    description: "Stop the current generation",
    category: "global",
  },
  focusComposer: {
    key: "l",
    meta: true,
    shift: true,
    label: "Focus composer",
    description: "Focus the message input",
    category: "global",
  },
  toggleTheme: {
    key: "d",
    meta: true,
    shift: true,
    label: "Toggle theme",
    description: "Switch between light and dark mode",
    category: "global",
  },
  commandPalette: {
    key: "k",
    meta: true,
    label: "Command palette",
    description: "Open command palette",
    category: "global",
  },
  keyboardHelp: {
    key: "/",
    meta: true,
    label: "Keyboard shortcuts",
    description: "Show keyboard shortcuts",
    category: "global",
  },
  sidebarNavUp: {
    key: "k",
    label: "Previous session",
    description: "Navigate to previous session in sidebar",
    category: "sidebar",
  },
  sidebarNavDown: {
    key: "j",
    label: "Next session",
    description: "Navigate to next session in sidebar",
    category: "sidebar",
  },
};

export function matchesShortcut(
  e: KeyboardEvent,
  shortcut: Shortcut,
): boolean {
  const metaMatch = shortcut.meta ? e.metaKey || e.ctrlKey : !e.metaKey && !e.ctrlKey;
  const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
  const altMatch = shortcut.alt ? e.altKey : !e.altKey;
  return metaMatch && shiftMatch && altMatch && e.key.toLowerCase() === shortcut.key;
}

export function formatShortcut(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.meta) parts.push("\u2318");
  if (shortcut.shift) parts.push("\u21E7");
  if (shortcut.alt) parts.push("\u2325");
  parts.push(shortcut.key.toUpperCase());
  return parts.join("");
}
