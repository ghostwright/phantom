// Stream event and assistant message handlers for the SDK-to-wire translator.
// Split from sdk-to-wire.ts to keep both files under 300 lines.

import type { ChatWireFrame } from "./types.ts";

export type TranslationContext = {
	sessionId: string;
	messageId: string;
	turnIndex: number;
	seenBlockLengths: Map<number, number>;
	startedToolIds: Set<string>;
	assistantStartEmitted: boolean;
	blockTypes: Map<number, "text" | "thinking" | "tool_use">;
	blockToolIds: Map<number, string>;
};

export function handleAssistant(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const frames: ChatWireFrame[] = [];
	const message = msg.message as {
		content: Array<Record<string, unknown>>;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	if (!message?.content) return frames;

	const parentToolUseId = (msg.parent_tool_use_id as string | null) ?? null;

	if (!ctx.assistantStartEmitted) {
		ctx.assistantStartEmitted = true;
		frames.push({
			event: "message.assistant_start",
			message_id: ctx.messageId,
			parent_tool_use_id: parentToolUseId,
		});
	}

	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		const blockType = block.type as string;

		if (blockType === "text") {
			const fullText = (block.text as string) ?? "";
			if (ctx.blockTypes.get(i) === "text") {
				// Stream deltas already shipped this block. Emit a single reconcile
				// frame so the client replaces the accumulated text with the
				// canonical final text. No-op at the UI if they already match.
				frames.push({
					event: "message.text_reconcile",
					text_block_id: `tb_${ctx.turnIndex}_${i}`,
					full_text: fullText,
				});
				ctx.seenBlockLengths.set(i, fullText.length);
			} else {
				const prevLen = ctx.seenBlockLengths.get(i) ?? 0;
				if (prevLen === 0) {
					frames.push({
						event: "message.text_start",
						message_id: ctx.messageId,
						text_block_id: `tb_${ctx.turnIndex}_${i}`,
						index: i,
					});
				}
				if (fullText.length > prevLen) {
					frames.push({
						event: "message.text_delta",
						text_block_id: `tb_${ctx.turnIndex}_${i}`,
						delta: fullText.slice(prevLen),
					});
				}
				ctx.seenBlockLengths.set(i, fullText.length);
			}
		} else if (blockType === "thinking" || blockType === "redacted_thinking") {
			// Thinking blocks use a Map-indirect client reducer: `thinking_start`
			// REPLACES the Map entry, and `thinking_delta` appends to it. That
			// makes `thinking_start + thinking_delta(fullText)` idempotent across
			// the streamed and non-streamed paths, AND correctly snaps the
			// client's Map entry to the canonical text when the stream deltas
			// diverged from the final assistant text (e.g. stream="abc",
			// final="abcd"). So we always emit on the final pass. The text path
			// above uses a dedicated reconcile frame because its reducer is
			// array-of-blocks and that idempotence guarantee does not hold there.
			const thinkingText = (block.thinking as string) ?? "";
			const prevLen = ctx.seenBlockLengths.get(i) ?? 0;
			const redacted = blockType === "redacted_thinking";
			if (prevLen === 0) {
				frames.push({
					event: "message.thinking_start",
					message_id: ctx.messageId,
					thinking_block_id: `tk_${ctx.turnIndex}_${i}`,
					index: i,
					redacted,
				});
			}
			if (!redacted && thinkingText.length > prevLen) {
				frames.push({
					event: "message.thinking_delta",
					thinking_block_id: `tk_${ctx.turnIndex}_${i}`,
					delta: thinkingText.slice(prevLen),
				});
			}
			ctx.seenBlockLengths.set(i, thinkingText.length);
		} else if (blockType === "tool_use") {
			const toolId = (block.id as string) ?? `tool_${i}`;
			if (!ctx.startedToolIds.has(toolId)) {
				ctx.startedToolIds.add(toolId);
				const toolName = (block.name as string) ?? "unknown";
				const isMcp = toolName.includes(":") || toolName.startsWith("mcp_");
				frames.push({
					event: "message.tool_call_start",
					message_id: ctx.messageId,
					tool_call_id: toolId,
					tool_name: toolName,
					parent_tool_use_id: parentToolUseId,
					is_mcp: isMcp,
					mcp_server: isMcp ? toolName.split(":")[0] : undefined,
				});
				if (block.input !== undefined) {
					frames.push({
						event: "message.tool_call_input_end",
						tool_call_id: toolId,
						input: block.input,
					});
					ctx.seenBlockLengths.set(i, JSON.stringify(block.input).length);
				}
			}
		}
	}

	return frames;
}

export function handleStreamEvent(msg: Record<string, unknown>, ctx: TranslationContext): ChatWireFrame[] {
	const frames: ChatWireFrame[] = [];
	const event = msg.event as Record<string, unknown>;
	if (!event) return frames;

	const parentToolUseId = (msg.parent_tool_use_id as string | null) ?? null;
	const eventType = event.type as string;

	if (!ctx.assistantStartEmitted && eventType !== "message_stop") {
		ctx.assistantStartEmitted = true;
		frames.push({
			event: "message.assistant_start",
			message_id: ctx.messageId,
			parent_tool_use_id: parentToolUseId,
		});
	}

	switch (eventType) {
		case "content_block_start": {
			const block = event.content_block as Record<string, unknown>;
			const index = event.index as number;
			const blockType = block?.type as string;

			if (blockType === "text") {
				ctx.blockTypes.set(index, "text");
				frames.push({
					event: "message.text_start",
					message_id: ctx.messageId,
					text_block_id: `tb_${ctx.turnIndex}_${index}`,
					index,
				});
			} else if (blockType === "thinking" || blockType === "redacted_thinking") {
				ctx.blockTypes.set(index, "thinking");
				frames.push({
					event: "message.thinking_start",
					message_id: ctx.messageId,
					thinking_block_id: `tk_${ctx.turnIndex}_${index}`,
					index,
					redacted: blockType === "redacted_thinking",
				});
			} else if (blockType === "tool_use") {
				ctx.blockTypes.set(index, "tool_use");
				const toolId = (block.id as string) ?? `tool_${index}`;
				ctx.startedToolIds.add(toolId);
				ctx.blockToolIds.set(index, toolId);
				const toolName = (block.name as string) ?? "unknown";
				const isMcp = toolName.includes(":") || toolName.startsWith("mcp_");
				frames.push({
					event: "message.tool_call_start",
					message_id: ctx.messageId,
					tool_call_id: toolId,
					tool_name: toolName,
					parent_tool_use_id: parentToolUseId,
					is_mcp: isMcp,
					mcp_server: isMcp ? toolName.split(":")[0] : undefined,
				});
			}
			break;
		}
		case "content_block_delta": {
			const delta = event.delta as Record<string, unknown>;
			const index = event.index as number;
			const deltaType = delta?.type as string;

			if (deltaType === "text_delta") {
				frames.push({
					event: "message.text_delta",
					text_block_id: `tb_${ctx.turnIndex}_${index}`,
					delta: (delta.text as string) ?? "",
				});
			} else if (deltaType === "thinking_delta") {
				frames.push({
					event: "message.thinking_delta",
					thinking_block_id: `tk_${ctx.turnIndex}_${index}`,
					delta: (delta.thinking as string) ?? "",
				});
			} else if (deltaType === "input_json_delta") {
				frames.push({
					event: "message.tool_call_input_delta",
					tool_call_id: ctx.blockToolIds.get(index) ?? `unknown_${index}`,
					json_delta: (delta.partial_json as string) ?? "",
				});
			}
			break;
		}
		case "content_block_stop": {
			const index = event.index as number;
			const stoppedType = ctx.blockTypes.get(index);
			if (stoppedType === "text") {
				frames.push({ event: "message.text_end", text_block_id: `tb_${ctx.turnIndex}_${index}` });
			} else if (stoppedType === "thinking") {
				frames.push({ event: "message.thinking_end", thinking_block_id: `tk_${ctx.turnIndex}_${index}` });
			} else if (stoppedType === "tool_use") {
				const toolId = ctx.blockToolIds.get(index);
				if (toolId) {
					frames.push({ event: "message.tool_call_input_end", tool_call_id: toolId, input: {} });
				}
			}
			break;
		}
		case "message_stop": {
			if (ctx.assistantStartEmitted) {
				frames.push({
					event: "message.assistant_end",
					message_id: ctx.messageId,
					interrupted: false,
				});
			}
			break;
		}
	}

	return frames;
}
