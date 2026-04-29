// Minimal HTML entity escape for the five characters that matter in
// quoted attributes and element content. Used by server-side page
// generators to defend against operator-supplied brand strings.
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
