// Re-export the canonical escapeHtml from shared/strings.ts so existing
// callers that import from "chat/util/escape.ts" continue to work unchanged.
export { escapeHtml } from "../../shared/strings.ts";
