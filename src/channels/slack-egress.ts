// Phase 5b: shared Slack API egress helpers. Both `SlackChannel`
// (Socket Mode) and `SlackHttpChannel` (HTTP receiver) need to post
// messages, open DMs, update messages, and add/remove reactions through
// the Bolt `App["client"]`. The mechanics are identical regardless of
// transport, so the methods live here and the channels delegate.
//
// Keeping these helpers transport-agnostic also lets the receiver class
// stay focused on lifecycle (HMAC verification, auth.test, port binding)
// without inflating past the 300-line file budget. Each helper logs with
// a caller-supplied tag so the source channel is identifiable in logs.

import { randomUUID } from "node:crypto";
import type { App } from "@slack/bolt";
import type { SlackBlock } from "./feedback.ts";
import { buildFeedbackBlocks } from "./feedback.ts";
import { splitMessage, toSlackMarkdown, truncateForSlack } from "./slack-formatter.ts";
import type { OutboundMessage, SentMessage } from "./types.ts";

export type EgressContext = {
	client: App["client"];
	channelId: string;
	logTag: string;
};

export async function egressSend(
	ctx: EgressContext,
	conversationId: string,
	message: OutboundMessage,
): Promise<SentMessage> {
	const { channel, threadTs } = parseConversationId(conversationId);
	const formattedText = toSlackMarkdown(message.text);
	const replyThreadTs = message.threadId ?? threadTs;
	const chunks = splitMessage(formattedText);
	let lastTs = "";
	for (const chunk of chunks) {
		const result = await ctx.client.chat.postMessage({
			channel,
			text: chunk,
			thread_ts: replyThreadTs,
		});
		lastTs = result.ts ?? "";
	}
	return {
		id: lastTs || randomUUID(),
		channelId: ctx.channelId,
		conversationId,
		timestamp: new Date(),
	};
}

export async function egressPostToChannel(ctx: EgressContext, channelId: string, text: string): Promise<string | null> {
	const formattedText = toSlackMarkdown(text);
	const chunks = splitMessage(formattedText);
	let lastTs: string | null = null;
	for (const chunk of chunks) {
		try {
			const result = await ctx.client.chat.postMessage({ channel: channelId, text: chunk });
			lastTs = result.ts ?? null;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[${ctx.logTag}] Failed to post to channel ${channelId}: ${msg}`);
			return null;
		}
	}
	return lastTs;
}

// egressSendDm opens a DM channel and posts the message. When `blocks`
// is provided, the message ships as a Block Kit payload with `text` as
// the screen-reader and notification fallback (Slack truncates long
// fallbacks; the caller is expected to keep the fallback under 3000
// chars). The blocks payload bypasses splitMessage chunking because
// blocks must travel as a single chat.postMessage; if the blocks shape
// is too large for Slack the API returns an error which we log and
// return null. When `blocks` is omitted the helper falls back to the
// text-chunked path through egressPostToChannel.
export async function egressSendDm(
	ctx: EgressContext,
	userId: string,
	text: string,
	blocks?: SlackBlock[],
): Promise<string | null> {
	try {
		const openResult = await ctx.client.conversations.open({ users: userId });
		const dmChannelId = openResult.channel?.id;
		if (!dmChannelId) {
			console.error(`[${ctx.logTag}] Failed to open DM with user ${userId}: no channel returned`);
			return null;
		}
		if (!blocks || blocks.length === 0) {
			return egressPostToChannel(ctx, dmChannelId, text);
		}
		try {
			const postArgs: Record<string, unknown> = { channel: dmChannelId, text, blocks };
			const result = await ctx.client.chat.postMessage(
				postArgs as unknown as Parameters<typeof ctx.client.chat.postMessage>[0],
			);
			return result.ts ?? null;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[${ctx.logTag}] Failed to post DM blocks to user ${userId}: ${msg}`);
			return null;
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[${ctx.logTag}] Failed to send DM to user ${userId}: ${msg}`);
		return null;
	}
}

export async function egressPostThinking(
	ctx: EgressContext,
	channel: string,
	threadTs: string,
): Promise<string | null> {
	try {
		const result = await ctx.client.chat.postMessage({
			channel,
			thread_ts: threadTs,
			text: "Working on it...",
		});
		return result.ts ?? null;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${ctx.logTag}] Failed to post thinking indicator: ${msg}`);
		return null;
	}
}

export async function egressUpdateMessage(
	ctx: EgressContext,
	channel: string,
	ts: string,
	text: string,
	blocks?: SlackBlock[],
): Promise<void> {
	const formattedText = toSlackMarkdown(text);
	const truncated = truncateForSlack(formattedText);
	try {
		// Bolt's chat.update has a strict overload-driven signature that does
		// not accept the dynamically-built record cleanly; the runtime checks
		// inside Bolt validate the same shape we build, so we relax to the
		// parameter type via `as unknown as`.
		const updateArgs: Record<string, unknown> = { channel, ts, text: truncated };
		if (blocks) updateArgs.blocks = blocks;
		await ctx.client.chat.update(updateArgs as unknown as Parameters<typeof ctx.client.chat.update>[0]);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${ctx.logTag}] Failed to update message: ${msg}`);
	}
}

export async function egressUpdateWithFeedback(
	ctx: EgressContext,
	channel: string,
	ts: string,
	text: string,
): Promise<void> {
	const formattedText = toSlackMarkdown(text);
	const truncated = truncateForSlack(formattedText);
	const feedbackBlocks = buildFeedbackBlocks(ts);
	const blocks: SlackBlock[] = [{ type: "section", text: { type: "mrkdwn", text: truncated } }, ...feedbackBlocks];
	try {
		// Same Bolt overload story as egressUpdateMessage.
		const updateArgs: Record<string, unknown> = { channel, ts, text: truncated, blocks };
		await ctx.client.chat.update(updateArgs as unknown as Parameters<typeof ctx.client.chat.update>[0]);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${ctx.logTag}] Failed to update message with feedback: ${msg}`);
	}
}

export async function egressAddReaction(
	ctx: EgressContext,
	channel: string,
	messageTs: string,
	emoji: string,
): Promise<void> {
	try {
		await ctx.client.reactions.add({ channel, timestamp: messageTs, name: emoji });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("already_reacted")) {
			console.warn(`[${ctx.logTag}] Failed to add reaction :${emoji}:: ${msg}`);
		}
	}
}

export async function egressRemoveReaction(
	ctx: EgressContext,
	channel: string,
	messageTs: string,
	emoji: string,
): Promise<void> {
	try {
		await ctx.client.reactions.remove({ channel, timestamp: messageTs, name: emoji });
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		if (!msg.includes("no_reaction")) {
			console.warn(`[${ctx.logTag}] Failed to remove reaction :${emoji}:: ${msg}`);
		}
	}
}

function parseConversationId(conversationId: string): { channel: string; threadTs: string | undefined } {
	const parts = conversationId.split(":");
	if (parts[1] === "dm") {
		return { channel: parts[2], threadTs: undefined };
	}
	return { channel: parts[1], threadTs: parts[2] };
}
