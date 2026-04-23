/**
 * Convert standard markdown to Slack mrkdwn format.
 * Slack uses its own variant: *bold*, _italic_, ~strike~, <url|text> links.
 */

// Sentinel strings used to protect code blocks during markdown conversion
const CODE_BLOCK_SENTINEL = "\u200BCODEBLOCK_";
const INLINE_CODE_SENTINEL = "\u200BINLINE_";
const SENTINEL_END = "\u200B";

const codeBlockRestorePattern = new RegExp(`${CODE_BLOCK_SENTINEL}(\\d+)${SENTINEL_END}`, "g");
const inlineCodeRestorePattern = new RegExp(`${INLINE_CODE_SENTINEL}(\\d+)${SENTINEL_END}`, "g");

export function toSlackMarkdown(text: string): string {
	if (!text) return text;

	let result = text;

	// Preserve code blocks from being processed
	const codeBlocks: string[] = [];
	result = result.replace(/```[\s\S]*?```/g, (match) => {
		codeBlocks.push(match);
		return `${CODE_BLOCK_SENTINEL}${codeBlocks.length - 1}${SENTINEL_END}`;
	});

	// Preserve inline code
	const inlineCodes: string[] = [];
	result = result.replace(/`[^`]+`/g, (match) => {
		inlineCodes.push(match);
		return `${INLINE_CODE_SENTINEL}${inlineCodes.length - 1}${SENTINEL_END}`;
	});

	// Convert bold: **text** -> *text*
	result = result.replace(/\*\*([^*]+)\*\*/g, "*$1*");

	// Convert italic: _text_ stays the same in Slack
	// Convert __text__ (some markdown uses double underscore for bold) -> *text*
	result = result.replace(/__([^_]+)__/g, "*$1*");

	// Convert strikethrough: ~~text~~ -> ~text~
	result = result.replace(/~~([^~]+)~~/g, "~$1~");

	// Convert links: [text](url) -> <url|text>
	result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

	// Convert headers: ## Header -> *Header*
	result = result.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

	// Convert unordered lists: - item or * item -> bullet
	result = result.replace(/^[\s]*[-*]\s+/gm, "\u2022 ");

	// Restore inline code
	result = result.replace(inlineCodeRestorePattern, (_, idx) => inlineCodes[Number(idx)]);

	// Restore code blocks
	result = result.replace(codeBlockRestorePattern, (_, idx) => codeBlocks[Number(idx)]);

	return result;
}

/**
 * Max characters for a Slack section block's mrkdwn text field.
 * Slack's hard cap is 3000; we leave ~100 chars of headroom for truncation
 * notices and other post-hoc additions.
 */
export const SLACK_BLOCK_TEXT_MAX = 2900;

/**
 * Truncate text to fit inside a single Slack mrkdwn section block.
 * If truncated, appends a notice.
 */
export function truncateForSlack(text: string, limit = SLACK_BLOCK_TEXT_MAX): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n_(Response truncated. Full response was ${text.length} characters.)_`;
}

/**
 * Split a long message into multiple chunks at safe boundaries.
 * Each chunk fits inside a single Slack mrkdwn section block.
 */
export function splitMessage(text: string, maxLength = SLACK_BLOCK_TEXT_MAX): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Find a good split point: prefer double newline, then single newline, then space
		let splitAt = remaining.lastIndexOf("\n\n", maxLength);
		if (splitAt < maxLength * 0.5) {
			splitAt = remaining.lastIndexOf("\n", maxLength);
		}
		if (splitAt < maxLength * 0.3) {
			splitAt = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitAt < maxLength * 0.2) {
			splitAt = maxLength;
		}

		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt).trimStart();
	}

	return chunks;
}
