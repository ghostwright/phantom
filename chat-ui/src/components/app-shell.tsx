import { PanelLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Toaster } from "@/ui/sonner";
import { useBootstrap } from "@/hooks/use-bootstrap";
import { useKeyboard } from "@/hooks/use-keyboard";
import { useSessions } from "@/hooks/use-sessions";
import { useTheme } from "@/hooks/use-theme";
import { useIsMobile } from "@/hooks/use-mobile";
import { CommandPalette } from "./command-palette";
import { DeleteSessionDialog } from "./delete-session-dialog";
import { KeyboardHelpSheet } from "./keyboard-help-sheet";
import { SidebarPanel } from "./sidebar-panel";

export function AppShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { sessions, isLoading, createSession, deleteSession, updateSession } =
    useSessions();
  const { toggleTheme } = useTheme();
  const isMobile = useIsMobile();
  const { data: bootstrap, cachedName, cachedAvatarUrl } = useBootstrap();

  const agentName = bootstrap?.agent_name ?? cachedName ?? "Agent";
  const avatarUrl = bootstrap?.avatar_url ?? cachedAvatarUrl ?? null;
  const [avatarBroken, setAvatarBroken] = useState(false);

  const [sidebarOpen, setSidebarOpen] = useState(!isMobile);
  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    title: string | null;
  } | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  // Update the browser tab title once we know the agent name. Picks up
  // cached name immediately on reload and refreshes when fresh data lands.
  useEffect(() => {
    if (agentName && agentName !== "Agent") {
      document.title = agentName;
    }
  }, [agentName]);

  // Post agent name to the Service Worker so push notifications with no
  // title fall back to the real agent name instead of "Phantom".
  useEffect(() => {
    if (!agentName || agentName === "Agent") return;
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        reg.active?.postMessage({ type: "SET_AGENT_NAME", agentName });
      })
      .catch(() => {});
  }, [agentName]);

  // Mirror the avatar URL into the Service Worker so push notifications
  // render the operator's logo. Null unsets any cached icon.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    navigator.serviceWorker.ready
      .then((reg) => {
        reg.active?.postMessage({ type: "SET_AVATAR_URL", url: avatarUrl });
      })
      .catch(() => {});
  }, [avatarUrl]);

  // Reset the broken flag when the URL changes (new upload -> retry display).
  useEffect(() => {
    setAvatarBroken(false);
  }, [avatarUrl]);

  const handleNewSession = useCallback(async () => {
    const id = await createSession();
    navigate(`/s/${id}`);
  }, [createSession, navigate]);

  const handleSessionClick = useCallback(
    (id: string) => {
      navigate(`/s/${id}`);
      if (isMobile) setSidebarOpen(false);
    },
    [navigate, isMobile],
  );

  const handleRename = useCallback(
    (id: string, title: string) => {
      updateSession(id, { title });
    },
    [updateSession],
  );

  const handleDeleteRequest = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id);
      setDeleteTarget({ id, title: session?.title ?? null });
    },
    [sessions],
  );

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteTarget) return;
    deleteSession(deleteTarget.id);
    setDeleteTarget(null);
    if (deleteTarget.id === sessionId) {
      navigate("/");
    }
  }, [deleteTarget, deleteSession, sessionId, navigate]);

  const handleShowKeyboardHelp = useCallback(() => {
    setHelpOpen(true);
  }, []);

  const handleStopGeneration = useCallback(() => {
    // SessionRoute listens for this event and calls abort on the active
    // chat hook. Using a custom event keeps AppShell decoupled from the
    // per-route chat state.
    window.dispatchEvent(new CustomEvent("phantom:stop-generation"));
  }, []);

  const handleFocusComposer = useCallback(() => {
    const el = document.getElementById("chat-composer");
    if (el && typeof (el as HTMLElement).focus === "function") {
      (el as HTMLElement).focus();
    }
  }, []);

  useKeyboard({
    newSession: handleNewSession,
    toggleTheme,
    keyboardHelp: handleShowKeyboardHelp,
    stopGeneration: handleStopGeneration,
    focusComposer: handleFocusComposer,
  });

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to main content
      </a>
      <a
        href="#chat-composer"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-14 focus:z-50 focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground"
      >
        Skip to composer
      </a>

      {sidebarOpen && (
        <div className="w-64 shrink-0 border-r border-border">
          <SidebarPanel
            sessions={sessions}
            isLoading={isLoading}
            activeSessionId={sessionId ?? null}
            onSessionClick={handleSessionClick}
            onNewSession={handleNewSession}
            onRename={handleRename}
            onDelete={handleDeleteRequest}
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 items-center border-b border-border px-4">
          <button
            type="button"
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="mr-3 text-muted-foreground hover:text-foreground"
            aria-label={sidebarOpen ? "Close sidebar" : "Open sidebar"}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
          {avatarUrl && !avatarBroken ? (
            <img
              src={avatarUrl}
              alt=""
              className="mr-2 h-5 w-5 rounded-md object-cover"
              onError={() => setAvatarBroken(true)}
            />
          ) : null}
          <span className="text-sm font-medium text-foreground">
            {agentName}
          </span>
        </header>

        <main id="main-content" className="flex min-h-0 flex-1 flex-col">{children}</main>
      </div>

      <CommandPalette
        sessions={sessions}
        onNewSession={handleNewSession}
        onSessionClick={handleSessionClick}
        onShowKeyboardHelp={handleShowKeyboardHelp}
      />

      <KeyboardHelpSheet open={helpOpen} onOpenChange={setHelpOpen} />

      <DeleteSessionDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleDeleteConfirm}
        sessionTitle={deleteTarget?.title ?? null}
      />

      <Toaster position="bottom-right" />
    </div>
  );
}
