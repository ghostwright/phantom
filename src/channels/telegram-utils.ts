/**
 * Utility functions for Telegram message formatting and splitting.
 */

export const TELEGRAM_MAX_LENGTH = 4000;

/**
 * Split a message into chunks that fit within Telegram's 4096 char limit.
 * Prefers splitting at newlines to preserve readability.
 */
export function splitMessage(text: string): string[] {
	if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > 0) {
		if (remaining.length <= TELEGRAM_MAX_LENGTH) {
			chunks.push(remaining);
			break;
		}
		// Prefer splitting at a newline near the limit
		let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
		if (splitAt < TELEGRAM_MAX_LENGTH / 2) splitAt = TELEGRAM_MAX_LENGTH;
		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}
	return chunks;
}

/** Strip HTML tags for plain-text fallback. */
export function stripHtml(html: string): string {
	return html
		.replace(/<[^>]+>/g, "")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

/**
 * Convert GitHub-flavored markdown to Telegram HTML.
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a>
 */
export function markdownToTelegramHtml(text: string): string {
	const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	// 1. Preserve fenced code blocks
	const codeBlocks: string[] = [];
	let out = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, _lang, code: string) => {
		codeBlocks.push(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
		return `\x00CB${codeBlocks.length - 1}\x00`;
	});

	// 2. Preserve inline code
	const inlineCodes: string[] = [];
	out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		inlineCodes.push(`<code>${esc(code)}</code>`);
		return `\x00IC${inlineCodes.length - 1}\x00`;
	});

	// 3. Escape HTML special chars in remaining text
	out = esc(out);

	// 4. Headings to bold
	out = out.replace(/^#{1,6} (.+)$/gm, "<b>$1</b>");

	// 5. Bold: **text** or __text__
	out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	out = out.replace(/__(.+?)__/g, "<b>$1</b>");

	// 6. Italic: *text* or _text_ (single, not double)
	out = out.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<i>$1</i>");
	out = out.replace(/(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g, "<i>$1</i>");

	// 7. Strikethrough: ~~text~~
	out = out.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// 8. Unordered list items: "- text" or "* text" at line start
	out = out.replace(/^[*-] (.+)$/gm, "• $1");

	// 9. Restore inline code and code blocks
	for (let i = 0; i < inlineCodes.length; i++) {
		out = out.replace(`\x00IC${i}\x00`, inlineCodes[i] as string);
	}
	for (let i = 0; i < codeBlocks.length; i++) {
		out = out.replace(`\x00CB${i}\x00`, codeBlocks[i] as string);
	}

	return out;
}
