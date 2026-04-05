/**
 * Slack interactive action handlers: feedback buttons and agent-suggested actions.
 * Registers Bolt action handlers that route button clicks to the appropriate
 * subsystems (feedback -> evolution, actions -> agent follow-up).
 */

import type { App } from "@slack/bolt";
import { FEEDBACK_ACTION_IDS, buildFeedbackAckBlocks, emitFeedback, parseFeedbackAction } from "./feedback.ts";

type ActionFollowUpHandler = (params: {
	userId: string;
	channel: string;
	threadTs: string;
	actionLabel: string;
	actionPayload?: string;
	conversationId: string;
}) => Promise<void>;

let actionFollowUpHandler: ActionFollowUpHandler | null = null;

export function setActionFollowUpHandler(handler: ActionFollowUpHandler): void {
	actionFollowUpHandler = handler;
}

// Loop stop button handler. The `phantom:loop_stop:<id>` action_id is attached
// to the initial loop status message, allowing an operator to interrupt a
// running loop from Slack without invoking the MCP tool.
type LoopStopHandler = (loopId: string) => boolean;

let loopStopHandler: LoopStopHandler | null = null;

export function setLoopStopHandler(handler: LoopStopHandler): void {
	loopStopHandler = handler;
}

export const LOOP_STOP_ACTION_PREFIX = "phantom:loop_stop:";

/** Extract a typed value from the Bolt body object */
function bodyField<T>(body: unknown, ...keys: string[]): T | undefined {
	let obj = body as Record<string, unknown> | undefined;
	for (const key of keys) {
		if (!obj || typeof obj !== "object") return undefined;
		obj = obj[key] as Record<string, unknown> | undefined;
	}
	return obj as unknown as T | undefined;
}

export function registerSlackActions(app: App): void {
	// Register feedback button handlers
	for (const actionId of FEEDBACK_ACTION_IDS) {
		app.action(actionId, async ({ ack, body, client }) => {
			await ack();

			const b = body as unknown as Record<string, unknown>;
			const actions = b.actions as Array<{ action_id: string; value?: string }> | undefined;
			if (!actions?.[0]) return;

			const feedbackType = parseFeedbackAction(actions[0].action_id);
			if (!feedbackType) return;

			const channelId = bodyField<string>(b, "channel", "id");
			const messageTs = bodyField<string>(b, "message", "ts");
			const userId = bodyField<string>(b, "user", "id");
			const threadTs = bodyField<string>(b, "message", "thread_ts") ?? messageTs;
			const messageText = bodyField<string>(b, "message", "text") ?? "";
			const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];

			if (!channelId || !messageTs || !userId) return;

			emitFeedback({
				type: feedbackType,
				conversationId: `slack:${channelId}:${threadTs}`,
				messageTs,
				userId,
				source: "button",
				timestamp: Date.now(),
			});

			// Replace feedback buttons with acknowledgment
			const nonFeedbackBlocks = existingBlocks.filter((block) => {
				return !block.block_id?.startsWith("phantom_feedback_");
			});
			// Remove trailing divider
			const cleaned = nonFeedbackBlocks.filter((block, i) => {
				if (block.type === "divider" && i === nonFeedbackBlocks.length - 1) return false;
				return true;
			});

			const ackBlocks = buildFeedbackAckBlocks(feedbackType);

			try {
				await client.chat.update({
					channel: channelId,
					ts: messageTs,
					text: messageText,
					blocks: [...cleaned, ...ackBlocks],
				} as unknown as Parameters<typeof client.chat.update>[0]);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[slack] Failed to update feedback buttons: ${msg}`);
			}
		});
	}

	// Register loop stop button handler
	app.action(/^phantom:loop_stop:.+$/, async ({ ack, body, client }) => {
		await ack();

		const b = body as unknown as Record<string, unknown>;
		const actions = b.actions as Array<{ action_id: string }> | undefined;
		const actionId = actions?.[0]?.action_id;
		if (!actionId?.startsWith(LOOP_STOP_ACTION_PREFIX)) return;

		const loopId = actionId.slice(LOOP_STOP_ACTION_PREFIX.length);
		const channelId = bodyField<string>(b, "channel", "id");
		const messageTs = bodyField<string>(b, "message", "ts");
		const userId = bodyField<string>(b, "user", "id");
		const messageText = bodyField<string>(b, "message", "text") ?? "";
		const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];

		const stopped = loopStopHandler?.(loopId) ?? false;

		if (channelId && messageTs) {
			const nonActionBlocks = existingBlocks.filter((block) => block.block_id !== `phantom_loop_actions_${loopId}`);
			const noteText = stopped
				? `_<@${userId}> requested stop. The loop will halt before the next iteration._`
				: `_<@${userId}> clicked stop, but the loop is already finished._`;
			try {
				await client.chat.update({
					channel: channelId,
					ts: messageTs,
					text: messageText,
					blocks: [...nonActionBlocks, { type: "context", elements: [{ type: "mrkdwn", text: noteText }] }],
				} as unknown as Parameters<typeof client.chat.update>[0]);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.warn(`[slack] Failed to update loop stop message: ${msg}`);
			}
		}
	});

	// Register agent action button handler
	app.action(/^phantom:action:\d+$/, async ({ ack, body, client }) => {
		await ack();

		const b = body as unknown as Record<string, unknown>;
		const actions = b.actions as Array<{ action_id: string; value?: string }> | undefined;
		if (!actions?.[0]) return;

		const value = actions[0].value ?? "";
		const channelId = bodyField<string>(b, "channel", "id");
		const messageTs = bodyField<string>(b, "message", "ts");
		const userId = bodyField<string>(b, "user", "id");
		const threadTs = bodyField<string>(b, "message", "thread_ts") ?? messageTs;
		const messageText = bodyField<string>(b, "message", "text") ?? "";
		const existingBlocks = bodyField<Array<{ type: string; block_id?: string }>>(b, "message", "blocks") ?? [];

		if (!channelId || !messageTs || !userId) return;

		let label = "action";
		let payload: string | undefined;
		try {
			const parsed = JSON.parse(value);
			label = parsed.label ?? label;
			payload = parsed.payload;
		} catch {
			label = value;
		}

		// Replace action buttons with a note showing what was clicked
		const nonActionBlocks = existingBlocks.filter((block) => {
			return block.block_id !== "phantom_actions";
		});

		try {
			await client.chat.update({
				channel: channelId,
				ts: messageTs,
				text: messageText,
				blocks: [
					...nonActionBlocks,
					{
						type: "context",
						elements: [{ type: "mrkdwn", text: `_<@${userId}> clicked: ${label}_` }],
					},
				],
			} as unknown as Parameters<typeof client.chat.update>[0]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.warn(`[slack] Failed to update action buttons: ${msg}`);
		}

		// Route to agent as follow-up
		if (actionFollowUpHandler) {
			await actionFollowUpHandler({
				userId,
				channel: channelId,
				threadTs: threadTs ?? messageTs,
				actionLabel: label,
				actionPayload: payload,
				conversationId: `slack:${channelId}:${threadTs}`,
			});
		}
	});
}
