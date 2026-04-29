import { useEffect } from "react";
import { matchesShortcut, shortcuts } from "@/lib/keymap";

type ShortcutHandlers = Partial<Record<keyof typeof shortcuts, () => void>>;

export function useKeyboard(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Skip if user is typing in an input/textarea (except for meta shortcuts)
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      for (const [name, shortcut] of Object.entries(shortcuts)) {
        if (!matchesShortcut(e, shortcut)) continue;

        // Only allow meta shortcuts when in an input
        if (isInput && !shortcut.meta) continue;

        const handler = handlers[name as keyof typeof shortcuts];
        if (handler) {
          e.preventDefault();
          handler();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlers]);
}
