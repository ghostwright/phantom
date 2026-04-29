import { useMemo } from "react";
import type { SessionSummary } from "@/lib/client";
import { SidebarSessionItem } from "./sidebar-session-item";

type DateGroup = {
  label: string;
  sessions: SessionSummary[];
};

function groupSessionsByDate(sessions: SessionSummary[]): DateGroup[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const last7 = new Date(today.getTime() - 7 * 86400000);
  const last30 = new Date(today.getTime() - 30 * 86400000);

  const groups: Record<string, SessionSummary[]> = {
    Today: [],
    Yesterday: [],
    "Last 7 days": [],
    "Last 30 days": [],
    Older: [],
  };

  for (const session of sessions) {
    const date = new Date(session.last_message_at ?? session.created_at);
    if (date >= today) {
      groups["Today"]!.push(session);
    } else if (date >= yesterday) {
      groups["Yesterday"]!.push(session);
    } else if (date >= last7) {
      groups["Last 7 days"]!.push(session);
    } else if (date >= last30) {
      groups["Last 30 days"]!.push(session);
    } else {
      groups["Older"]!.push(session);
    }
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, sessions: items }));
}

export function SidebarSessionList({
  sessions,
  activeSessionId,
  onSessionClick,
  onRename,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSessionClick: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const pinned = useMemo(
    () => sessions.filter((s) => s.pinned),
    [sessions],
  );
  const unpinned = useMemo(
    () => sessions.filter((s) => !s.pinned),
    [sessions],
  );
  const groups = useMemo(() => groupSessionsByDate(unpinned), [unpinned]);

  return (
    <div className="flex-1 overflow-y-auto px-2">
      {pinned.length > 0 && (
        <div className="mb-2">
          <div className="px-2 py-1 text-xs font-medium text-sidebar-muted-foreground">
            Pinned
          </div>
          {pinned.map((session) => (
            <SidebarSessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSessionClick(session.id)}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {groups.map((group) => (
        <div key={group.label} className="mb-2">
          <div className="px-2 py-1 text-xs font-medium text-sidebar-muted-foreground">
            {group.label}
          </div>
          {group.sessions.map((session) => (
            <SidebarSessionItem
              key={session.id}
              session={session}
              isActive={session.id === activeSessionId}
              onClick={() => onSessionClick(session.id)}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      ))}

      {sessions.length === 0 && (
        <div className="px-2 py-8 text-center text-sm text-muted-foreground">
          No conversations yet
        </div>
      )}
    </div>
  );
}
