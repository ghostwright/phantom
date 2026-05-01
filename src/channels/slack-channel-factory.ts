// Phase 5b: factory that picks between Socket Mode (`SlackChannel`) and the
// HTTP receiver (`SlackHttpChannel`) based on the SLACK_TRANSPORT env var.
// Pulled out of `src/index.ts` so the dispatch logic has a unit-testable
// surface; the index.ts wiring just calls this factory.

import { DEFAULT_METADATA_BASE_URL, MetadataIdentityFetcher, type SlackIdentity } from "../config/identity-fetcher.ts";
import { MetadataSecretFetcher } from "../config/metadata-fetcher.ts";
import type { ChannelsConfig } from "../config/schemas.ts";
import { type IntroductionLedger, SlackHttpChannel } from "./slack-http-receiver.ts";
import type { SlackMetricsEmitter } from "./slack-metrics.ts";
import type { SlackTransport } from "./slack-transport.ts";
import { SlackChannel } from "./slack.ts";

export type SlackTransportMode = "socket" | "http";

/**
 * Cross-repo invariant: every Slack-related secret name fetched from
 * phantomd's metadata gateway MUST appear in phantomd's
 * `internal/secrets/types.go` `AllowedSecretNames` map. The gateway maps a
 * non-allowed name to ErrInvalidName -> HTTP 404 (name-enumeration defense),
 * so a drift between this list and the phantomd allowlist breaks tenant
 * boot with no actionable error in the in-VM Phantom logs.
 *
 * The list below is the authoritative phantom-side Slack mirror. Adding a
 * Slack secret to this array implies a matching addition in phantomd's
 * `AllowedSecretNames`; removing one requires that no callsite in this file
 * still fetches it. The mirror is exported (vs. private to this module) so
 * the factory test fixture can pin the same constant against its
 * `SECRET_RESPONSES` allowlist; future re-orderings won't silently desync.
 *
 * Phase 8a addition (R7 dated 2026-04-30): `slack_app_token` joins the
 * pair, gating the Socket Mode WSS dial for self-installed agent #2+
 * tenants. The corresponding phantomd entry landed in PR #28
 * (TestIsAllowedName_AcceptsSlackAppToken pins the symmetric assertion).
 *
 * Audit Finding 1 (cross-repo audit, dated 2026-04-25): the
 * `slack_gateway_signing_secret` entry pairs with phantom-slack-events'
 * outbound HMAC that the SlackHttpChannel verifies on every forwarded
 * event. Distinct from the Slack-issued `signing_secret` which lives in
 * phantom-slack-events' TOML config and never traverses the metadata
 * gateway.
 *
 * Phase 10 PR 10-3 (Resend, dated 2026-05-01): the broader cross-channel
 * mirror (Slack plus Email plus future channels) lives in
 * `src/config/secret-names.ts::AllowedSecretNamesMirror`. This file keeps
 * the Slack-scoped subset as the authoritative list its own callsites
 * fetch; new email-side names land in the broader mirror, not here.
 */
export const AllowedSecretNamesMirror = Object.freeze([
	"slack_bot_token",
	"slack_app_token",
	"slack_gateway_signing_secret",
] as const);

export type CreateSlackChannelInput = {
	transport: SlackTransportMode;
	channelsConfig: ChannelsConfig | null;
	metadataBaseUrl?: string;
	// The identity and secrets fetchers are injectable so tests can substitute
	// mocks without going through real fetch. In production, omit them and the
	// factory constructs the link-local default fetchers.
	identityFetcher?: { get(): Promise<{ slack?: SlackIdentity }> };
	secretsFetcher?: { get(name: string): Promise<string> };
	/**
	 * Phase 8a metrics emitter. Forwarded to the Socket Mode `SlackChannel`
	 * so its lifecycle hooks update the four metric series exposed on
	 * `/metrics`. The HTTP receiver does not consume metrics in this PR; a
	 * follow-up generalizes the surface (Phase 17).
	 */
	metrics?: SlackMetricsEmitter;
	/**
	 * Persistent intro-DM ledger forwarded to the HTTP receiver. The
	 * receiver consults it before firing the synthetic first DM so a
	 * process restart does not re-DM the installer, and stamps it on a
	 * successful send so /health reports onboarding complete. Socket
	 * Mode does not use this surface (its onboarding lives in
	 * `src/onboarding/flow.ts`).
	 */
	introductionLedger?: IntroductionLedger;
};

/**
 * Returns the Slack channel implementation appropriate for the configured
 * transport mode, or `null` when no Slack channel can be constructed (the
 * Socket Mode path with no Slack creds in channels.yaml is the only happy
 * "no channel" case; everything else throws so misconfiguration is loud).
 *
 * The HTTP path is always loud on misconfiguration because a tenant booting
 * with SLACK_TRANSPORT=http but no /v1/identity.slack install means the
 * provisioning flow is broken and we want the operator to know immediately.
 */
export async function createSlackChannel(input: CreateSlackChannelInput): Promise<SlackTransport | null> {
	if (input.transport === "socket") {
		const sc = input.channelsConfig?.slack;
		if (!sc?.enabled || !sc.bot_token || !sc.app_token) return null;
		return new SlackChannel({
			botToken: sc.bot_token,
			appToken: sc.app_token,
			defaultChannelId: sc.default_channel_id,
			ownerUserId: sc.owner_user_id,
			metrics: input.metrics,
		});
	}

	if (input.transport === "http") {
		const baseUrl = input.metadataBaseUrl ?? DEFAULT_METADATA_BASE_URL;
		const idFetcher = input.identityFetcher ?? new MetadataIdentityFetcher(baseUrl);
		const secFetcher = input.secretsFetcher ?? new MetadataSecretFetcher(baseUrl);
		const identity = await idFetcher.get();
		if (!identity.slack) {
			throw new Error(
				"SLACK_TRANSPORT=http requires a Slack install in /v1/identity.slack; got none. " +
					"Run the OAuth flow via phantom-control or revert to SLACK_TRANSPORT=socket.",
			);
		}
		// Cross-repo invariant: see AllowedSecretNamesMirror at the top of this
		// file. The HTTP path consumes "slack_bot_token" +
		// "slack_gateway_signing_secret"; the Socket Mode path additionally
		// consumes "slack_app_token" via channels.yaml (R7 §6.4 will move it
		// onto the gateway in Phase 8b). Drift between this file and
		// phantomd's AllowedSecretNames breaks tenant boot with HTTP 404 (the
		// gateway maps ErrInvalidName to 404 to avoid name enumeration). The
		// regression is pinned by slack-channel-factory.test.ts's name-aware
		// mock, which throws on any unexpected name; phantomd pins the same
		// contract via TestIsAllowedName_Accepts{SlackGatewaySigningSecret,
		// SlackAppToken}.
		const [botToken, signingSecret] = await Promise.all([
			secFetcher.get("slack_bot_token"),
			secFetcher.get("slack_gateway_signing_secret"),
		]);
		return new SlackHttpChannel({
			botToken,
			gatewaySigningSecret: signingSecret,
			teamId: identity.slack.teamId,
			installerUserId: identity.slack.installerUserId,
			teamName: identity.slack.teamName,
			introductionLedger: input.introductionLedger,
		});
	}

	throw new Error(`Unknown SLACK_TRANSPORT: ${String(input.transport)} (expected "socket" or "http")`);
}

export function readSlackTransportFromEnv(env: NodeJS.ProcessEnv = process.env): SlackTransportMode {
	const value = env.SLACK_TRANSPORT?.trim();
	if (!value || value === "socket") return "socket";
	if (value === "http") return "http";
	throw new Error(`Unknown SLACK_TRANSPORT: ${value} (expected "socket" or "http")`);
}
