import { Suspense } from "react";
import {
  createBrowserRouter,
  Outlet,
  RouterProvider,
} from "react-router-dom";
import { AppShell } from "@/components/app-shell";
import { ChatRoute } from "@/routes/chat-route";
import { NewChatRoute } from "@/routes/new-chat-route";
import { NotFoundRoute } from "@/routes/not-found-route";
import { SessionRoute } from "@/routes/session-route";

function Layout() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          </div>
        }
      >
        <Outlet />
      </Suspense>
    </AppShell>
  );
}

const router = createBrowserRouter(
  [
    {
      element: <Layout />,
      children: [
        { path: "chat", element: <ChatRoute /> },
        { path: "chat/s/:sessionId", element: <SessionRoute /> },
        { path: "chat/new", element: <NewChatRoute /> },
        { path: "s/:sessionId", element: <SessionRoute /> },
        { path: "new", element: <NewChatRoute /> },
        { path: "*", element: <NotFoundRoute /> },
      ],
    },
  ],
);

export function App() {
  return <RouterProvider router={router} />;
}
