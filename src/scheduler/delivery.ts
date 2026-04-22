import type { SlackChannel } from "../channels/slack.ts";
import type { ScheduledJob } from "./types.ts";

/**
 * Outcome string stored in scheduled_jobs.last_delivery_status.
 * null (column default) means "never attempted".
 * Anything returned from deliverResult is a concrete attempt outcome.
 */
export type DeliveryOutcome =
	| "delivered"
	| "skipped:channel_none"
	| "dropped:slack_channel_unset"
	| "dropped:owner_user_id_unset"
	| "dropped:telegram_bot_token_unset"
	| "dropped:telegram_owner_chat_id_unset"
	| `dropped:unknown_target:${string}`
	| `error:${string}`;

export type DeliveryContext = {
	slackChannel: SlackChannel | undefined;
	ownerUserId: string | null;
};

/**
 * Send the job's run text to its configured delivery target and report the
 * outcome. Every exit path returns a concrete outcome so the scheduler can
 * persist it and so operators never see a silently dropped message.
 *
 * The "telegram" branch uses raw Bot API fetch with TELEGRAM_BOT_TOKEN +
 * OWNER_TELEGRAM_USER_ID env vars — no polling, no conflict with the bot
 * instance that channels/telegram.ts is running. Keeping the scheduler path
 * off the Telegraf client isolates sendMessage from getUpdates concurrency.
 *
 * SlackChannel.sendDm and postToChannel catch errors internally and return
 * `null` on failure rather than throwing. We treat a null return as an error
 * outcome so a real Slack outage surfaces as "error:slack_returned_null"
 * instead of being stamped "delivered" in last_delivery_status. The try/catch
 * remains as a belt-and-braces guard in case a future Slack layer change
 * starts throwing instead.
 *
 * Target validation already happened at creation time. The runtime fallthrough
 * branch here is the safety net for the "Slack configured but owner missing"
 * case and for any future target shape the validator misses.
 */
export async function deliverResult(job: ScheduledJob, text: string, ctx: DeliveryContext): Promise<DeliveryOutcome> {
	if (job.delivery.channel === "none") {
		return "skipped:channel_none";
	}

	if (job.delivery.channel === "telegram") {
		return deliverTelegram(job, text);
	}

	if (job.delivery.channel !== "slack") {
		return `dropped:unknown_target:${job.delivery.channel}`;
	}

	if (!ctx.slackChannel) {
		console.error(
			`[scheduler] Delivery dropped for job "${job.name}": Slack channel is not wired. Configure channels.yaml with slack.enabled=true, bot_token, app_token.`,
		);
		return "dropped:slack_channel_unset";
	}

	const target = job.delivery.target;

	try {
		if (target === "owner") {
			if (!ctx.ownerUserId) {
				console.error(
					`[scheduler] Delivery dropped for job "${job.name}": target=owner but channels.yaml slack.owner_user_id is not configured. Set owner_user_id or use an explicit user (U...) or channel (C...) target.`,
				);
				return "dropped:owner_user_id_unset";
			}
			const ts = await ctx.slackChannel.sendDm(ctx.ownerUserId, text);
			if (ts === null) {
				console.error(
					`[scheduler] Delivery error for job "${job.name}" target=owner: Slack sendDm returned null (upstream API failure)`,
				);
				return "error:slack_returned_null";
			}
			return "delivered";
		}
		if (target.startsWith("C")) {
			const ts = await ctx.slackChannel.postToChannel(target, text);
			if (ts === null) {
				console.error(
					`[scheduler] Delivery error for job "${job.name}" target=${target}: Slack postToChannel returned null (upstream API failure)`,
				);
				return "error:slack_returned_null";
			}
			return "delivered";
		}
		if (target.startsWith("U")) {
			const ts = await ctx.slackChannel.sendDm(target, text);
			if (ts === null) {
				console.error(
					`[scheduler] Delivery error for job "${job.name}" target=${target}: Slack sendDm returned null (upstream API failure)`,
				);
				return "error:slack_returned_null";
			}
			return "delivered";
		}

		// Defensive: the creation-time validator should never let us reach here.
		console.error(`[scheduler] Delivery dropped for job "${job.name}": unknown target format: ${target}`);
		return `dropped:unknown_target:${target}`;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[scheduler] Delivery error for job "${job.name}" target="${target}": ${msg}`);
		// Compact the error so it fits in the status column without leaking newlines.
		const compact = msg.replace(/\s+/g, " ").slice(0, 200);
		return `error:${compact}`;
	}
}

/**
 * Telegram delivery path. Reads TELEGRAM_BOT_TOKEN and OWNER_TELEGRAM_USER_ID
 * from env directly rather than threading them through DeliveryContext, which
 * would require executor.ts + service.ts + index.ts changes. The raw fetch
 * against Bot API does not poll, so it cannot conflict with the running
 * Telegraf instance that channels/telegram.ts owns.
 *
 * Telegram messages are sent as plain text (no parse_mode) to avoid the
 * MarkdownV2 escaping burden here. Scheduler task outputs are generally
 * plain text anyway.
 */
async function deliverTelegram(job: ScheduledJob, text: string): Promise<DeliveryOutcome> {
	const token = process.env.TELEGRAM_BOT_TOKEN;
	if (!token) {
		console.error(
			`[scheduler] Delivery dropped for job "${job.name}": TELEGRAM_BOT_TOKEN env is not set. Configure it in .env.`,
		);
		return "dropped:telegram_bot_token_unset";
	}

	const rawTarget = job.delivery.target;
	let chatId: string;
	if (rawTarget === "owner") {
		const owner = process.env.OWNER_TELEGRAM_USER_ID;
		if (!owner) {
			console.error(
				`[scheduler] Delivery dropped for job "${job.name}": target=owner but OWNER_TELEGRAM_USER_ID env is not set.`,
			);
			return "dropped:telegram_owner_chat_id_unset";
		}
		chatId = owner;
	} else {
		chatId = rawTarget;
	}

	// Telegram has a 4096-char limit per message; truncate defensively with a
	// trailing indicator so operators can see content was cut rather than
	// chasing a silent API error.
	const MAX_LEN = 4000;
	const payload = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}\n\n… [truncated, ${text.length - MAX_LEN} chars]` : text;

	try {
		const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text: payload, disable_web_page_preview: true }),
		});
		if (!resp.ok) {
			const body = await resp.text().catch(() => "");
			const compact = body.replace(/\s+/g, " ").slice(0, 200);
			console.error(
				`[scheduler] Delivery error for job "${job.name}" target=${rawTarget}: Telegram API ${resp.status}: ${compact}`,
			);
			return `error:telegram_api_${resp.status}:${compact}`;
		}
		return "delivered";
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[scheduler] Delivery error for job "${job.name}" target=${rawTarget}: ${msg}`);
		const compact = msg.replace(/\s+/g, " ").slice(0, 200);
		return `error:${compact}`;
	}
}
