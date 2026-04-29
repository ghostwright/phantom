import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/ui/sheet";
import { shortcuts, formatShortcut } from "@/lib/keymap";

export function KeyboardHelpSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const categories = {
    global: "Global",
    composer: "Composer",
    sidebar: "Sidebar",
    message: "Message",
  } as const;

  const grouped = Object.entries(shortcuts).reduce(
    (acc, [, shortcut]) => {
      const cat = shortcut.category;
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(shortcut);
      return acc;
    },
    {} as Record<string, (typeof shortcuts)[string][]>,
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:w-96">
        <SheetHeader>
          <SheetTitle>Keyboard shortcuts</SheetTitle>
          <SheetDescription>
            Available keyboard shortcuts for the chat interface.
          </SheetDescription>
        </SheetHeader>
        <div className="mt-4 space-y-4">
          {Object.entries(categories).map(([key, label]) => {
            const items = grouped[key];
            if (!items?.length) return null;
            return (
              <div key={key}>
                <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                  {label}
                </h3>
                <div className="space-y-1">
                  {items.map((shortcut) => (
                    <div
                      key={shortcut.label}
                      className="flex items-center justify-between py-1"
                    >
                      <span className="text-sm text-foreground">
                        {shortcut.description}
                      </span>
                      <kbd className="rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                        {formatShortcut(shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}
