// Helpers for security-wrapping MessageParam content. Typed with `unknown`
// internally to work even when @anthropic-ai/sdk types are not resolvable
// on CI (the agent SDK imports MessageParam from a transitive dep that
// does not reliably hoist in all package managers).

import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type MessageParam = SDKUserMessage["message"];

export function extractTextFromMessageParam(message: MessageParam): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const texts: string[] = [];
	for (const block of message.content as unknown[]) {
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && b.text) texts.push(b.text);
	}
	return texts.join("\n");
}

export function wrapMessageContent(message: MessageParam, wrapFn: (text: string) => string): MessageParam {
	if (typeof message.content === "string") {
		return { ...message, content: wrapFn(message.content) };
	}
	if (!Array.isArray(message.content)) {
		return { ...message, content: wrapFn("") };
	}
	const arr = message.content as unknown[];
	// Find the last text block - wrap only that one (matches single-string Slack path)
	let lastTextIdx = -1;
	for (let i = 0; i < arr.length; i++) {
		const b = arr[i] as { type?: string };
		if (b.type === "text") lastTextIdx = i;
	}
	const wrapped = [];
	for (let i = 0; i < arr.length; i++) {
		const b = arr[i] as { type?: string; text?: string };
		if (i === lastTextIdx && b.type === "text" && b.text) {
			wrapped.push({ ...(arr[i] as Record<string, unknown>), text: wrapFn(b.text) });
		} else {
			wrapped.push(arr[i]);
		}
	}
	return { ...message, content: wrapped as typeof message.content };
}
