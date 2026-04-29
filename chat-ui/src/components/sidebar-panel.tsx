import { Plus } from "lucide-react";
import { Button } from "@/ui/button";
import { SidebarSessionList } from "./sidebar-session-list";
import { SidebarFooter } from "./sidebar-footer";
import type { SessionSummary } from "@/lib/client";

export function SidebarPanel({
  sessions,
  isLoading,
  activeSessionId,
  onSessionClick,
  onNewSession,
  onRename,
  onDelete,
}: {
  sessions: SessionSummary[];
  isLoading: boolean;
  activeSessionId: string | null;
  onSessionClick: (id: string) => void;
  onNewSession: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="flex h-full flex-col bg-sidebar">
      <div className="flex items-center justify-between border-b border-sidebar-border px-3 py-3">
        <span className="text-sm font-semibold text-sidebar-foreground">
          Conversations
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNewSession}
          aria-label="New conversation"
          className="h-7 w-7"
        >
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        </div>
      ) : (
        <SidebarSessionList
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSessionClick={onSessionClick}
          onRename={onRename}
          onDelete={onDelete}
        />
      )}

      <SidebarFooter />
    </div>
  );
}
