// Synthetic introduction DM sent on the first connect of the HTTP Slack
// transport. Pulled out of slack-http-receiver.ts so the receiver class
// stays focused on lifecycle (HMAC verification, auth.test, port binding)
// without inflating past the 300-line file budget. Mirrors the
// slack-egress.ts factoring: any Slack send that BOTH transports could
// use lives in its own module so SlackChannel and SlackHttpChannel can
// adopt it without duplication. Today only SlackHttpChannel calls this;
// the Socket Mode path has its own onboarding DM flow elsewhere.
//
// The introduction is the user's first contact with the agent: when a
// hosted operator stamps an installer through the channel install flow,
// this DM is what the user sees first. The body is pinned by a test
// (composeIntroductionText test in __tests__). Change here, change
// there.

import { DEFAULT_METADATA_BASE_URL } from "../config/identity-fetcher.ts";
import { reportFirstDmSent } from "../tenancy/heartbeat.ts";
import { readSlackTransportFromEnv } from "./slack-channel-factory.ts";
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
	// the agent is in an HTTP-transport deployment, the first_dm_sent
	// heartbeat completed without a thrown exception. Best-effort
	// networking errors against the host metadata gateway are still
	// considered "sent" because the user has the DM in their Slack; the
	// caller's failed_first_dm path is reserved for the Slack-side
	// failure.
	sent: boolean;
	messageTs: string | null;
};

/**
 * Compose and send the introduction DM, then ack the host metadata
 * gateway when the agent is in an HTTP-transport deployment.
 *
 * Returns { sent: true, messageTs } on success. On any Slack-side
 * failure (no ts returned, exception thrown), returns { sent: false }
 * so the caller can decide whether to retry or surface a failure
 * signal to the operator. The function never throws; ALL errors are
 * logged and converted to sent: false so the caller's connect() flow
 * is not derailed by a transient Slack hiccup.
 */
export async function sendIntroductionDm(deps: IntroductionDeps): Promise<IntroductionResult> {
	const text = composeIntroductionText(deps.phantomName, deps.teamName, resolveDashboardUrl());
	try {
		const messageTs = await deps.sendDm(deps.installerUserId, text);
		if (!messageTs) {
			console.warn(`[${INTRODUCTION_LOG_TAG}] introduction DM returned no message_ts; skipping first_dm_sent ack`);
			return { sent: false, messageTs: null };
		}
		console.log(`[${INTRODUCTION_LOG_TAG}] sent introduction DM ts=${messageTs}`);

		// Best-effort attestation to the host metadata gateway. Mirrors
		// the index.ts agent_ready gate: HTTP transport is the signal
		// that there is a listener; the metadata URL falls back to the
		// same default the channel factory uses so unset
		// METADATA_BASE_URL is not a gating failure for HTTP-transport
		// tenants. The transport read goes through
		// readSlackTransportFromEnv so a whitespace-padded
		// SLACK_TRANSPORT (e.g. "  http  ") that boots the HTTP receiver
		// also fires this heartbeat; the raw env read missed that case
		// and left activation pending despite a successful DM.
		if (readSlackTransportFromEnv() === "http") {
			await reportFirstDmSent({
				metadataBaseUrl: process.env.METADATA_BASE_URL ?? DEFAULT_METADATA_BASE_URL,
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
// dashboardUrl is optional: when unset, the "manage me" line is omitted
// so self-hosters who do not have a management URL are not pointed at a
// dashboard they cannot reach. When set, the line appears verbatim.
export function composeIntroductionText(phantomName: string, teamName: string, dashboardUrl?: string): string {
	const lines = [
		`Hi! I'm ${phantomName}. I'm now connected to ${teamName}.`,
		"",
		"Reply to this DM to start a conversation, or @-mention me in any channel.",
		"",
		"A few things to try:",
		'  - "What can you do?"',
		'  - "Tell me about my workspace."',
		'  - "Read the latest in #general."',
	];
	if (dashboardUrl) {
		lines.push("", `You can manage me at ${dashboardUrl}.`);
	}
	return lines.join("\n");
}

// resolveDashboardUrl reads PHANTOM_DASHBOARD_URL and validates it as a
// well-formed URL. Operators set this in the agent's environment when
// the deployment has a management surface; self-hosters leave it unset
// and the "manage me" line is dropped from the introduction. A malformed
// value is logged and dropped so a misconfigured env var cannot inject
// unparseable text into a user-facing DM.
function resolveDashboardUrl(): string | undefined {
	const raw = process.env.PHANTOM_DASHBOARD_URL?.trim();
	if (!raw) return undefined;
	try {
		new URL(raw);
		return raw;
	} catch {
		console.warn(`[${INTRODUCTION_LOG_TAG}] PHANTOM_DASHBOARD_URL is not a valid URL; dropping the manage-me line`);
		return undefined;
	}
}
