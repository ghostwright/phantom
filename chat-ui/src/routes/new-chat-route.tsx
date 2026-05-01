import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createSession } from "@/lib/client";
import { CHAT_ROOT_PATH, chatSessionPath } from "@/lib/routes";

export function NewChatRoute() {
  const navigate = useNavigate();
  const didCreate = useRef(false);

  useEffect(() => {
    if (didCreate.current) return;
    didCreate.current = true;
    createSession()
      .then((result) => {
        navigate(chatSessionPath(result.id), { replace: true });
      })
      .catch(() => {
        navigate(CHAT_ROOT_PATH, { replace: true });
      });
  }, [navigate]);

  return (
    <div className="flex h-full items-center justify-center">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
    </div>
  );
}
