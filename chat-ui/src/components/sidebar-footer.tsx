import { useEffect, useState } from "react";
import { useBootstrap } from "@/hooks/use-bootstrap";
import { ThemeToggle } from "./theme-toggle";

export function SidebarFooter() {
  const { data, cachedName, cachedGen, cachedAvatarUrl } = useBootstrap();

  const agentName = data?.agent_name ?? cachedName ?? "Agent";
  const gen = data?.evolution_gen ?? cachedGen;
  const avatarUrl = data?.avatar_url ?? cachedAvatarUrl ?? null;
  const [avatarBroken, setAvatarBroken] = useState(false);

  // Reset the broken flag when a fresh avatar URL arrives (post-upload).
  useEffect(() => {
    setAvatarBroken(false);
  }, [avatarUrl]);

  return (
    <div className="border-t border-sidebar-border px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {avatarUrl && !avatarBroken ? (
            <img
              src={avatarUrl}
              alt=""
              className="h-8 w-8 shrink-0 rounded-md object-cover"
              onError={() => setAvatarBroken(true)}
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-sidebar-foreground">
              {agentName}
            </div>
            <div className="flex gap-2 text-xs text-sidebar-muted-foreground">
              {gen != null && gen > 0 && <span>Gen {gen}</span>}
            </div>
          </div>
        </div>
        <ThemeToggle />
      </div>
    </div>
  );
}
