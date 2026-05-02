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
// this DM is what the user sees first. Voice contract: co-worker on
// day 1, NOT chatbot. We greet by PHANTOM_OWNER_NAME when present, lead
// with one specific commitment (the 8am morning brief), and ask for
// confirmation via three Block Kit buttons rather than open-ended
// suggestion prompts. The body is pinned by the test in __tests__.
// Change here, change there.

import { DEFAULT_METADATA_BASE_URL } from "../config/identity-fetcher.ts";
import { type PersonaCatalogEntry, readPersonaFromEnv } from "../persona/catalog.ts";
import { reportFirstDmSent } from "../tenancy/heartbeat.ts";
import type { SlackBlock } from "./feedback.ts";
import { readSlackTransportFromEnv } from "./slack-channel-factory.ts";
import { redactTokens } from "./slack-http-utils.ts";

const INTRODUCTION_LOG_TAG = "slack-introduction";

// Block Kit action ids for the three morning-brief confirmation buttons.
// Exported so the actions dispatcher (slack-actions.ts) can register the
// matching handlers and the test can pin the wire shape.
export const MORNING_BRIEF_LOCK_ACTION_ID = "phantom:morning_brief:lock";
export const MORNING_BRIEF_RETIME_ACTION_ID = "phantom:morning_brief:retime";
export const MORNING_BRIEF_SKIP_ACTION_ID = "phantom:morning_brief:skip";

export type IntroductionDeps = {
	phantomName: string;
	teamName: string;
	installerUserId: string;
	// sendDm returns the Slack message_ts on success, or null when Slack
	// accepted the conversations.open but chat.postMessage failed (rate
	// limit, archived channel, etc). The blocks argument carries the
	// Block Kit shape; the text argument is the fallback for clients
	// that do not render blocks (mobile push notifications, screen
	// readers, the Slack search index). Inheriting the existing channel
	// helper keeps the egress test surface identical.
	sendDm(userId: string, text: string, blocks?: SlackBlock[]): Promise<string | null>;
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
	const ownerName = readOwnerName();
	const homeUrl = resolveHomeUrl();
	const dashboardUrl = resolveDashboardUrl();
	// Persona overlay (Slice 16b). When PHANTOM_PERSONA_ID is set and
	// matches a catalog entry, the intro DM swaps in the persona's
	// display_name + intro_* fields. The Block Kit wire shape (header,
	// section, three-button actions row, optional context footer) does
	// not change; only the text content shifts. When the env is unset or
	// unknown, the persona-less default copy from PR #120 ships
	// unchanged.
	const persona = readPersonaFromEnv();
	const text = composeIntroductionText(deps.phantomName, ownerName, homeUrl, dashboardUrl, persona);
	const blocks = composeIntroductionBlocks(deps.phantomName, ownerName, homeUrl, dashboardUrl, persona);
	try {
		const messageTs = await deps.sendDm(deps.installerUserId, text, blocks);
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

// composeIntroductionText is exported for the test that pins the copy
// AND as the text fallback for Slack clients that do not render blocks
// (mobile push previews, screen readers, the Slack search index). The
// shape is co-worker voice, not chatbot voice: a named greeting, a
// single concrete commitment (the 8am morning brief), and an offer to
// start now. No feature catalog, no "what can I help you with",
// no em dashes, no emojis.
//
// Five-or-fewer sentences by design. The voice contract is in the
// architect doc at phantom-cloud-deploy/local/2026-05-02-first-five-
// minutes-audit.md section 1.8 and the strategy doc at
// phantom-cloud-deploy/local/2026-05-02-phantom-as-product-strategy.md.
//
// Persona overlay (Slice 16b): when `persona` is provided, the named
// agent identity (display_name + intro_role_phrase) replaces the bare
// phantomName, the persona's first_commitment replaces the default
// morning-brief line, and the open_offer replaces the "start on
// something now" close. The buttons-below cue stays so the wire shape
// (Lock 8am / Pick another time / Skip mornings) maps straight to the
// persona's morning-brief commitment without a scaffold change.
export function composeIntroductionText(
	phantomName: string,
	ownerName?: string,
	homeUrl?: string,
	dashboardUrl?: string,
	persona?: PersonaCatalogEntry,
): string {
	const greeting = ownerName ? `Hi ${ownerName}.` : "Hi there.";
	const displayName = persona?.display_name ?? phantomName;
	const rolePhrase = persona?.intro_role_phrase;
	// Lead sentence. Persona-tweaked: "I'm Lilian, your SDR." Default:
	// "I'm in." The location ("I live at <homeUrl>") and the
	// in-this-Slack-from-now-on commitment carry across both branches so
	// the user always sees where the agent lives and what it's doing.
	const namedSelf = persona ? `I'm ${displayName}, ${rolePhrase}.` : "I'm in.";
	const introSentence = homeUrl
		? persona
			? `${namedSelf} I live at ${homeUrl} and I'll be in this Slack from now on.`
			: `${namedSelf} I live at ${homeUrl} and I'll be your co-worker in this Slack as ${phantomName} from now on.`
		: persona
			? `${namedSelf} I'll be in this Slack from now on.`
			: `${namedSelf} I'll be your co-worker in this Slack as ${phantomName} from now on.`;
	const commitmentLine = persona
		? `${persona.intro_first_commitment}. Lock it in, pick another time, or skip mornings using the buttons below.`
		: "Tomorrow at 8am your time I'll send you a quick read on what changed overnight and what needs you. Lock it in, pick another time, or skip mornings using the buttons below.";
	const offerLine = persona
		? `${persona.intro_open_offer}.`
		: "If you want me to start on something now, just tell me what.";
	// Text fallback for clients that do not render Block Kit (mobile push
	// previews, screen readers, the Slack search index). The buttons row
	// is replaced with a "tap a button below" cue so screen-reader users
	// hear that there is something to interact with rather than dead-end
	// at the question; the buttons themselves render in the blocks
	// payload above this fallback.
	const lines = [`${greeting} ${introSentence}`, "", commitmentLine, "", offerLine];
	if (dashboardUrl) {
		lines.push("", `If you want to change anything about me, I live at ${dashboardUrl}.`);
	}
	return lines.join("\n");
}

// composeIntroductionBlocks renders the introduction as Slack Block Kit:
// a header, a section with the body, an actions row with three buttons,
// and a context footer (when a dashboard URL is configured) so the user
// has a route back to the management surface without it crowding the
// primary copy. The buttons confirm the morning-brief schedule; the
// handlers in slack-actions.ts persist the choice and update the message
// to acknowledge the click.
//
// Persona overlay (Slice 16b): when `persona` is provided, the header
// switches to "${persona.display_name} is in." and the body section
// uses the persona's named-self lead sentence + intro_first_commitment
// + intro_open_offer. The actions row block_id, the three button
// action_ids, the primary style on Lock 8am, and the context footer
// shape stay byte-equal with the persona-less default; slice 15
// reads the click events from the same handlers regardless of which
// persona shipped the DM.
export function composeIntroductionBlocks(
	phantomName: string,
	ownerName?: string,
	homeUrl?: string,
	dashboardUrl?: string,
	persona?: PersonaCatalogEntry,
): SlackBlock[] {
	const greeting = ownerName ? `Hi ${ownerName}.` : "Hi there.";
	const displayName = persona?.display_name ?? phantomName;
	const rolePhrase = persona?.intro_role_phrase;
	const namedSelfMrkdwn = persona ? `I'm *${displayName}*, ${rolePhrase}.` : "I'm in.";
	const introSentence = homeUrl
		? persona
			? `${namedSelfMrkdwn} I live at <${homeUrl}|${stripScheme(homeUrl)}> and I'll be in this Slack from now on.`
			: `${namedSelfMrkdwn} I live at <${homeUrl}|${stripScheme(homeUrl)}> and I'll be your co-worker in this Slack as *${phantomName}* from now on.`
		: persona
			? `${namedSelfMrkdwn} I'll be in this Slack from now on.`
			: `${namedSelfMrkdwn} I'll be your co-worker in this Slack as *${phantomName}* from now on.`;
	const intro = `${greeting} ${introSentence}`;
	const commitment = persona
		? `${persona.intro_first_commitment}. Lock it in?`
		: "Tomorrow at 8am your time I'll send you a quick read on what changed overnight and what needs you. Lock it in?";
	const offer = persona
		? `${persona.intro_open_offer}.`
		: "If you want me to start on something now, just tell me what.";

	const blocks: SlackBlock[] = [
		{
			type: "header",
			text: { type: "plain_text", text: `${displayName} is in.` },
		},
		{
			type: "section",
			text: { type: "mrkdwn", text: `${intro}\n\n${commitment}` },
		},
		{
			type: "actions",
			block_id: "phantom_morning_brief",
			elements: [
				{
					type: "button",
					text: { type: "plain_text", text: "Lock 8am", emoji: false },
					action_id: MORNING_BRIEF_LOCK_ACTION_ID,
					style: "primary",
					value: "lock_8am",
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Pick another time", emoji: false },
					action_id: MORNING_BRIEF_RETIME_ACTION_ID,
					value: "retime",
				},
				{
					type: "button",
					text: { type: "plain_text", text: "Skip mornings", emoji: false },
					action_id: MORNING_BRIEF_SKIP_ACTION_ID,
					value: "skip",
				},
			],
		},
		{
			type: "section",
			text: { type: "mrkdwn", text: offer },
		},
	];

	if (dashboardUrl) {
		blocks.push({
			type: "context",
			elements: [
				{
					type: "mrkdwn",
					text: `If you want to change anything about me, I live at <${dashboardUrl}|${stripScheme(dashboardUrl)}>.`,
				},
			],
		});
	}

	return blocks;
}

// readOwnerName reads PHANTOM_OWNER_NAME and returns the trimmed value
// when non-empty. The greeting falls back to "Hi there." when the owner
// name is missing so the DM never reads as a half-finished mail merge
// (e.g. "Hi ,") to a self-hoster who has not set the env.
function readOwnerName(): string | undefined {
	const raw = process.env.PHANTOM_OWNER_NAME?.trim();
	return raw && raw.length > 0 ? raw : undefined;
}

// resolveHomeUrl reads PHANTOM_DOMAIN, falling back to a slug-derived
// hostname under phantom.ghostwright.dev so Phase-9-era tenants whose
// firstboot pre-dates the PHANTOM_DOMAIN injection still surface a real
// per-tenant URL. Returns undefined for single-tenant dev (neither var
// set) so the line drops cleanly.
function resolveHomeUrl(): string | undefined {
	const domain = process.env.PHANTOM_DOMAIN?.trim();
	if (domain && domain.length > 0) {
		const cleaned = domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
		if (cleaned.length > 0) return `https://${cleaned}`;
	}
	const slug = process.env.PHANTOM_TENANT_SLUG?.trim();
	if (slug && slug.length > 0) {
		return `https://${slug}.phantom.ghostwright.dev`;
	}
	return undefined;
}

// resolveDashboardUrl reads PHANTOM_DASHBOARD_URL and validates it as a
// well-formed URL. Operators set this in the agent's environment when
// the deployment has a management surface; self-hosters leave it unset
// and the dashboard footer line drops. A malformed value is logged and
// dropped so a misconfigured env var cannot inject unparseable text
// into a user-facing DM.
function resolveDashboardUrl(): string | undefined {
	const raw = process.env.PHANTOM_DASHBOARD_URL?.trim();
	if (!raw) return undefined;
	try {
		new URL(raw);
		return raw;
	} catch {
		console.warn(`[${INTRODUCTION_LOG_TAG}] PHANTOM_DASHBOARD_URL is not a valid URL; dropping the dashboard line`);
		return undefined;
	}
}

// stripScheme strips the URL scheme for cleaner Slack link display.
// Slack renders <url|label> with the label visible; we keep the URL
// readable by dropping the redundant https:// while leaving the
// underlying href intact.
function stripScheme(url: string): string {
	return url.replace(/^https?:\/\//i, "");
}
