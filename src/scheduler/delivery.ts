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
