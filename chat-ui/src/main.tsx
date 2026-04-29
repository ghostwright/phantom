import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readCachedAgentName } from "./hooks/use-bootstrap";
import "./styles/globals.css";

// Bootstrap theme before paint to prevent flash
const stored = localStorage.getItem("phantom-chat-theme");
const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
const isDark = stored === "dark" || (!stored && prefersDark);
document.documentElement.classList.toggle("dark", isDark);

// Bootstrap title before paint. The cached agent name from a previous
// load beats the HTML default "Phantom" so browser tabs, tab-search,
// and iOS tab switcher all show the real agent identity immediately.
// Route through readCachedAgentName() so the storage-key literal lives
// in exactly one place (use-bootstrap.ts) and key-rename migrations
// never drift between the pre-mount bootstrap and the hook.
const cachedName = readCachedAgentName();
if (cachedName) {
  document.title = cachedName;
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
