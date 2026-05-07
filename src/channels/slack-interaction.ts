/**
 * Slack channel interaction adapter.
 *
 * Phase 1 of the Telegram parity plan: extract the Slack-specific
 * orchestration code from `src/index.ts` (status reactions on the user's
 * message, progress streaming in the thread, response delivery with
 * feedback buttons) into a single adapter factory.
 *
 * This is a direct lift of the existing logic — no behavior change.
 * Existing Slack tests must continue to pass unchanged after the rewire
 * in `src/index.ts`.
 */

import type { ChannelInteractionFactory, ChannelInteractionInstance } from "./interaction-adapter.ts";
import type { SlackChannel } from "./slack.ts";
import type { InboundMessage } from "./types.ts";
import { createProgressStream, formatToolActivity, type ProgressStream } from "./progress-stream.ts";
import { createStatusReactionController, type StatusReactionController } from "./status-reactions.ts";

/**
 * Build a factory that produces Slack interaction adapters when the
 * inbound message originates from the given Slack channel instance.
 *
 * Returns null for non-Slack messages or when the channel argument
 * is null (Slack not configured).
 */
export function createSlackInteractionFactory(slackChannel: SlackChannel | null): ChannelInteractionFactory {
	return (msg: InboundMessage): ChannelInteractionInstance | null => {
		if (!slackChannel || msg.channelId !== "slack" || !msg.metadata) return null;

		const slackChannelId = msg.metadata.slackChannel as string | undefined;
		const slackThreadTs = msg.metadata.slackThreadTs as string | undefined;
		const slackMessageTs = msg.metadata.slackMessageTs as string | undefined;

		// Bind the channel locally so TypeScript narrowing survives the closures.
		const sc = slackChannel;

		// Status reactions on the user's message
		let statusReactions: StatusReactionController | undefined;
		if (slackChannelId && slackMessageTs) {
			const ch = slackChannelId;
			const mts = slackMessageTs;
			statusReactions = createStatusReactionController({
				adapter: {
					addReaction: (emoji) => sc.addReaction(ch, mts, emoji),
					removeReaction: (emoji) => sc.removeReaction(ch, mts, emoji),
				},
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[slack] Reaction error: ${errMsg}`);
				},
			});
			statusReactions.setQueued();
		}

		// Progress streaming in the thread
		let progressStream: ProgressStream | undefined;
		if (slackChannelId && slackThreadTs) {
			const ch = slackChannelId;
			const tts = slackThreadTs;
			progressStream = createProgressStream({
				adapter: {
					postMessage: (_t) => sc.postThinking(ch, tts).then((ts) => ts ?? ""),
					updateMessage: (msgId, updatedText) => sc.updateMessage(ch, msgId, updatedText),
				},
				onFinish: async (messageId, text) => {
					await sc.updateWithFeedback(ch, messageId, text);
				},
				onError: (err) => {
					const errMsg = err instanceof Error ? err.message : String(err);
					console.warn(`[slack] Progress stream error: ${errMsg}`);
				},
			});
		}

		const instance: ChannelInteractionInstance = {
			statusReactions,
			progressStream,

			async onTurnStart(): Promise<void> {
				if (progressStream) {
					await progressStream.start();
				}
			},

			onRuntimeEvent(event): void {
				switch (event.type) {
					case "thinking":
						statusReactions?.setThinking();
						break;
					case "tool_use":
						statusReactions?.setTool(event.tool);
						if (progressStream) {
							const summary = formatToolActivity(event.tool, event.input);
							progressStream.addToolActivity(event.tool, summary);
						}
						break;
					case "error":
						statusReactions?.setError();
						break;
				}
			},

			async deliverResponse({ text }): Promise<boolean> {
				if (progressStream) {
					// Slack happy path: update the progress message with the final
					// response + feedback buttons.
					await progressStream.finish(text);
					return true;
				}
				if (slackChannelId && slackThreadTs) {
					// Slack fallback: post a thinking indicator then upgrade it
					// with the final response + feedback buttons in one shot.
					const thinkingTs = await sc.postThinking(slackChannelId, slackThreadTs);
					if (thinkingTs) {
						await sc.updateWithFeedback(slackChannelId, thinkingTs, text);
						return true;
					}
				}
				return false;
			},

			dispose(): void {
				statusReactions?.dispose();
			},
		};

		return instance;
	};
}
