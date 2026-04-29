// Minimal HTML entity escape for the five characters that matter in
// quoted attributes and element content. Used by chat server code that
// interpolates operator-supplied strings (agent name) into email HTML
// and PWA manifest JSON. Matches src/ui/html.ts but lives in chat/ so
// chat modules do not reach across subsystems for a five-line helper.
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
