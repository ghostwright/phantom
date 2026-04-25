// Phase 5b: factory that picks between Socket Mode (`SlackChannel`) and the
// HTTP receiver (`SlackHttpChannel`) based on the SLACK_TRANSPORT env var.
// Pulled out of `src/index.ts` so the dispatch logic has a unit-testable
// surface; the index.ts wiring just calls this factory.

import { DEFAULT_METADATA_BASE_URL, MetadataIdentityFetcher, type SlackIdentity } from "../config/identity-fetcher.ts";
import { MetadataSecretFetcher } from "../config/metadata-fetcher.ts";
import type { ChannelsConfig } from "../config/schemas.ts";
import { SlackHttpChannel } from "./slack-http-receiver.ts";
import type { SlackTransport } from "./slack-transport.ts";
import { SlackChannel } from "./slack.ts";

export type SlackTransportMode = "socket" | "http";

export type CreateSlackChannelInput = {
	transport: SlackTransportMode;
	channelsConfig: ChannelsConfig | null;
	port: number;
	metadataBaseUrl?: string;
	// The identity and secrets fetchers are injectable so tests can substitute
	// mocks without going through real fetch. In production, omit them and the
	// factory constructs the link-local default fetchers.
	identityFetcher?: { get(): Promise<{ slack?: SlackIdentity }> };
	secretsFetcher?: { get(name: string): Promise<string> };
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
		// Cross-repo invariant (audit Finding 1, dated 2026-04-25): the names
		// "slack_bot_token" and "slack_gateway_signing_secret" must appear in
		// phantomd's internal/secrets/types.go AllowedSecretNames map. Drift on
		// either side breaks SLACK_TRANSPORT=http boot with HTTP 404 (the
		// gateway maps ErrInvalidName to 404 to avoid name enumeration). The
		// regression is pinned by slack-channel-factory.test.ts's name-aware
		// mock, which throws on any unexpected name; phantomd pins the same
		// contract via TestIsAllowedName_AcceptsSlackGatewaySigningSecret.
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
			listenPort: input.port,
			listenPath: "/slack",
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
