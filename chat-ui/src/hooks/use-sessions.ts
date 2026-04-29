import { useCallback, useEffect, useState } from "react";
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  listSessions,
  updateSession as apiUpdateSession,
  type SessionSummary,
} from "@/lib/client";

type UseSessionsReturn = {
  sessions: SessionSummary[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  createSession: (title?: string) => Promise<string>;
  deleteSession: (id: string) => Promise<void>;
  updateSession: (
    id: string,
    fields: { title?: string; pinned?: boolean },
  ) => Promise<void>;
};

export function useSessions(): UseSessionsReturn {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setIsLoading(true);
    listSessions(100)
      .then((result) => {
        setSessions(result.sessions);
        setError(null);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to load sessions";
        setError(msg);
      })
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createSession = useCallback(
    async (title?: string): Promise<string> => {
      const result = await apiCreateSession(title);
      refresh();
      return result.id;
    },
    [refresh],
  );

  const deleteSessionFn = useCallback(
    async (id: string): Promise<void> => {
      await apiDeleteSession(id);
      refresh();
    },
    [refresh],
  );

  const updateSessionFn = useCallback(
    async (
      id: string,
      fields: { title?: string; pinned?: boolean },
    ): Promise<void> => {
      await apiUpdateSession(id, fields);
      refresh();
    },
    [refresh],
  );

  return {
    sessions,
    isLoading,
    error,
    refresh,
    createSession,
    deleteSession: deleteSessionFn,
    updateSession: updateSessionFn,
  };
}
