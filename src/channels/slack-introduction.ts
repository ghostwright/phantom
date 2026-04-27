// Phase B.1.4: synthetic first DM for the Phantom Cloud canary.
//
// Pulled out of slack-http-receiver.ts so the receiver class stays focused
// on lifecycle (HMAC verification, auth.test, port binding) without
// inflating past the 300-line file budget. Mirrors the slack-egress.ts
// factoring: any Slack send that BOTH transports could use lives in its
// own module so SlackChannel and SlackHttpChannel can adopt it without
// duplication. Today only SlackHttpChannel calls this; the Socket Mode
// path has its own onboarding DM flow elsewhere.
//
// The introduction is the user's first contact with their Phantom: they
// clicked Launch in the wizard, watched the loader for ~25 seconds, and
// switched to Slack. This DM is what they came for. The copy is the
// architect plan section 12 (option A) text and changes there should
// propagate to the test that pins it.

import { reportFirstDmSent } from "../tenancy/heartbeat.ts";
import { redactTokens } from "./slack-http-utils.ts";

const INTRODUCTION_LOG_TAG = "slack-introduction";

export type IntroductionDeps = {
	phantomName: string;
	teamName: string;
	installerUserId: string;
	// sendDm returns the Slack message_ts on success, or null when Slack
	// accepted the conversations.open but chat.postMessage failed (rate
	// limit, archived channel, etc). Inheriting the existing channel
	// helper keeps the test surface identical.
	sendDm(userId: string, text: string): Promise<string | null>;
};

export type IntroductionResult = {
	// sent is true only when chat.postMessage returned a real ts AND, when
	// METADATA_BASE_URL is set, the first_dm_sent heartbeat completed
	// without a thrown exception. Best-effort networking errors against
	// the metadata gateway are still considered "sent" because the user
	// has the DM in their Slack; the wizard's failed_first_dm path is
	// reserved for the Slack-side failure.
	sent: boolean;
	messageTs: string | null;
};

/**
 * Compose and send the introduction DM, then ack the metadata gateway.
 *
 * Returns { sent: true, messageTs } on success. On any Slack-side
 * failure (no ts returned, exception thrown), returns { sent: false }
 * so the caller can decide whether to retry or surface a failure
 * signal to the operator. The function never throws; ALL errors are
 * logged and converted to sent: false so the caller's connect() flow
 * is not derailed by a transient Slack hiccup.
 */
export async function sendIntroductionDm(deps: IntroductionDeps): Promise<IntroductionResult> {
	const text = composeIntroductionText(deps.phantomName, deps.teamName);
	try {
		const messageTs = await deps.sendDm(deps.installerUserId, text);
		if (!messageTs) {
			console.warn(`[${INTRODUCTION_LOG_TAG}] introduction DM returned no message_ts; skipping first_dm_sent ack`);
			return { sent: false, messageTs: null };
		}
		console.log(`[${INTRODUCTION_LOG_TAG}] sent introduction DM ts=${messageTs}`);

		if (process.env.METADATA_BASE_URL) {
			await reportFirstDmSent({
				metadataBaseUrl: process.env.METADATA_BASE_URL,
				slackMessageTs: messageTs,
			});
		}
		return { sent: true, messageTs };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`[${INTRODUCTION_LOG_TAG}] introduction DM failed: ${redactTokens(msg)}`);
		return { sent: false, messageTs: null };
	}
}

// composeIntroductionText is exported for the test that pins the copy.
// The literal here is the architect plan section 12 (option A); changes
// to that section should propagate here and to the test.
export function composeIntroductionText(phantomName: string, teamName: string): string {
	return [
		`Hi! I'm ${phantomName}. I'm now connected to ${teamName}.`,
		"",
		"Reply to this DM to start a conversation, or @-mention me in any channel.",
		"",
		"A few things to try:",
		'  - "What can you do?"',
		'  - "Tell me about my workspace."',
		'  - "Read the latest in #general."',
		"",
		"You can manage me at https://ghostwright.dev/phantom/dashboard.",
	].join("\n");
}
