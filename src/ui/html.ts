// Re-export the canonical escapeHtml from shared/strings.ts so existing
// callers that import from "src/ui/html.ts" continue to work unchanged.
export { escapeHtml } from "../shared/strings.ts";
