/**
 * Shared string helpers used across subsystems. Each function is intentionally
 * small and side-effect-free so callers can import only what they need without
 * pulling in heavy dependencies.
 */

/** HTML entity escape for the five characters that matter in quoted attributes and element content. */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Truncate a string to `max` characters, appending "..." when shortened. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Type guard for plain objects (not null, not arrays). */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extract an error message from an unknown catch value. */
export function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
