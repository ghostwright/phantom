import { Paperclip } from "lucide-react";
import { Button } from "@/ui/button";

export function ChatInputToolbar({
  onPaperclipClick,
}: {
  onPaperclipClick?: () => void;
}) {
  return (
    <div className="flex items-center gap-1 px-1">
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-foreground"
        aria-label="Attach file"
        onClick={onPaperclipClick}
        title="Attach files"
      >
        <Paperclip className="h-4 w-4" />
      </Button>
    </div>
  );
}
