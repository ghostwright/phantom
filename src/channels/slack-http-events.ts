// Phase 5b: Bolt event-handler registrations for the HTTP receiver. These
// mirror the Socket Mode handlers in slack.ts so the agent's view of an
// inbound message is identical regardless of transport. The functions below
// take the `SlackHttpChannel` as a host argument; we pass the parts the
// handlers need (botUserId, teamId, messageHandler, reactionHandler) so the
// receiver class itself stays focused on lifecycle and Slack API egress.
//
// Defense in depth: the gateway and the middleware guard already verify
// team_id, but each handler also extracts team_id from the body and drops
// the event when it does not match this tenant's installer team. A missing
// team_id (`extractTeamIdFromBody` returns undefined) is treated as a
// non-match and dropped. The middleware allows `url_verification` through
// without a team_id, and Bolt handles that path before any handler runs.

import type { App } from "@slack/bolt";
import type { InboundMessage } from "./types.ts";

export type EventDispatchHost = {
	readonly id: string;
	getBotUserId(): string | null;
	getTeamId(): string;
	getMessageHandler(): ((message: InboundMessage) => Promise<void>) | null;
	getReactionHandler(): ReactionFn | null;
	stripBotMention(text: string): string;
};

export type ReactionFn = (event: {
	reaction: string;
	userId: string;
	messageTs: string;
	channel: string;
	isPositive: boolean;
}) => void;

export function registerHttpEventHandlers(app: App, host: EventDispatchHost): void {
	app.event("app_mention", async ({ event, body }) => {
		const handler = host.getMessageHandler();
		if (!handler) return;

		const eventTeamId = extractTeamIdFromBody(body);
		if (eventTeamId !== host.getTeamId()) {
			console.log(`[slack-http] Dropping app_mention with foreign or missing team_id: ${eventTeamId ?? "<none>"}`);
			return;
		}

		const senderId = event.user ?? "unknown";
		const cleanText = host.stripBotMention(event.text);
		if (!cleanText.trim()) return;

		const threadTs = event.thread_ts ?? event.ts;
		const conversationId = `slack:${event.channel}:${threadTs}`;

		const inbound: InboundMessage = {
			id: event.ts,
			channelId: host.id,
			conversationId,
			threadId: threadTs,
			senderId,
			text: cleanText.trim(),
			timestamp: new Date(Number.parseFloat(event.ts) * 1000),
			metadata: {
				slackChannel: event.channel,
				slackThreadTs: threadTs,
				slackMessageTs: event.ts,
				source: "app_mention",
			},
		};

		try {
			await handler(inbound);
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error(`[slack-http] Error handling app_mention: ${errMsg}`);
		}
	});

	app.event("message", async ({ event, body }) => {
		const handler = host.getMessageHandler();
		if (!handler) return;

		const m = event as unknown as Record<string, unknown>;
		if (m.subtype) return;
		if (m.bot_id) return;

		const userId = m.user as string | undefined;
		const botUserId = host.getBotUserId();
		if (botUserId && userId === botUserId) return;

		const channelType = m.channel_type as string | undefined;
		if (channelType !== "im") return;

		const eventTeamId = extractTeamIdFromBody(body);
		if (eventTeamId !== host.getTeamId()) {
			console.log(`[slack-http] Dropping DM with foreign or missing team_id: ${eventTeamId ?? "<none>"}`);
			return;
		}

		const text = (m.text as string) ?? "";
		if (!text.trim()) return;

		const channel = m.channel as string;
		const ts = m.ts as string;
		const threadTs = (m.thread_ts as string) ?? ts;
		const conversationId = `slack:${channel}:${threadTs}`;

		const inbound: InboundMessage = {
			id: ts,
			channelId: host.id,
			conversationId,
			threadId: threadTs,
			senderId: userId ?? "unknown",
			text: text.trim(),
			timestamp: new Date(Number.parseFloat(ts) * 1000),
			metadata: {
				slackChannel: channel,
				slackThreadTs: threadTs,
				slackMessageTs: ts,
				source: "dm",
			},
		};

		try {
			await handler(inbound);
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.error(`[slack-http] Error handling DM: ${errMsg}`);
		}
	});

	app.event("reaction_added", async ({ event, body }) => {
		const eventTeamId = extractTeamIdFromBody(body);
		if (eventTeamId !== host.getTeamId()) {
			console.log(`[slack-http] Dropping reaction with foreign or missing team_id: ${eventTeamId ?? "<none>"}`);
			return;
		}

		const reaction = event.reaction;
		const isPositive =
			reaction === "+1" || reaction === "thumbsup" || reaction === "heart" || reaction === "white_check_mark";
		const isNegative = reaction === "-1" || reaction === "thumbsdown" || reaction === "x";
		if (!isPositive && !isNegative) return;

		console.log(`[slack-http] Reaction ${isPositive ? "positive" : "negative"}: :${reaction}: from ${event.user}`);

		const reactionHandler = host.getReactionHandler();
		if (reactionHandler) {
			reactionHandler({
				reaction,
				userId: event.user,
				messageTs: event.item.ts,
				channel: event.item.channel,
				isPositive,
			});
		}
	});
}

function extractTeamIdFromBody(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const obj = body as Record<string, unknown>;
	if (typeof obj.team_id === "string") return obj.team_id;
	const team = obj.team as Record<string, unknown> | undefined;
	if (team && typeof team.id === "string") return team.id;
	return undefined;
}
