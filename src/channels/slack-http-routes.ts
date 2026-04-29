// Slack ingress routes mounted on Phantom's shared Bun.serve listener.
// `core/server.ts` calls `tryHandleSlackHttp(req, channel)` before
// returning 404 for unknown paths. The channel is supplied via a
// provider (set in src/index.ts after the Slack channel is created)
// and may be null for self-hosted deployments running Socket Mode,
// which never mount these routes.

import { SLACK_HTTP_PATHS } from "./slack-http-handlers.ts";
import type { SlackHttpChannel } from "./slack-http-receiver.ts";

let slackHttpChannelProvider: (() => SlackHttpChannel | null) | null = null;

export function setSlackHttpChannelProvider(provider: () => SlackHttpChannel | null): void {
	slackHttpChannelProvider = provider;
}

// Returns the Slack ingress Response for /slack/{events,interactivity,commands},
// or `null` when the path is not a Slack route or no HTTP-mode channel is
// wired (Socket Mode self-hosters fall through to the 404 path).
export async function tryHandleSlackHttp(req: Request): Promise<Response | null> {
	const url = new URL(req.url);
	if (!isSlackHttpPath(url.pathname)) return null;

	if (req.method !== "POST") {
		return new Response("method not allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	}

	const channel = slackHttpChannelProvider?.();
	if (!channel) {
		// Socket Mode tenants never mount these routes; an inbound POST is
		// either a probe or a misconfigured forwarder. 503 stays loud but
		// retryable so Slack's own retry schedule (up to 3 attempts within
		// 5 minutes) resolves a transient deploy-window race.
		return notReady("slack channel not configured");
	}
	if (!channel.isConnected()) {
		// The provider is wired in `src/index.ts` during channel setup
		// BEFORE `router.connectAll()` runs, so an inbound POST in the
		// startup window finds a channel object whose `connect()` (auth.test
		// + state flip) has not completed. The same gate covers the
		// post-`disconnect()` path (state flips back to "disconnected") and
		// the auth-failure path (state flips to "error"); only "connected"
		// passes. 503 lets Slack retry until the channel is ready instead
		// of accepting events that no listener is wired to handle.
		return notReady("slack channel not ready");
	}

	switch (url.pathname) {
		case SLACK_HTTP_PATHS.events:
			return channel.handleEvent(req);
		case SLACK_HTTP_PATHS.interactivity:
			return channel.handleInteractivity(req);
		case SLACK_HTTP_PATHS.commands:
			return channel.handleCommand(req);
		default:
			return null;
	}
}

function isSlackHttpPath(pathname: string): boolean {
	return (
		pathname === SLACK_HTTP_PATHS.events ||
		pathname === SLACK_HTTP_PATHS.interactivity ||
		pathname === SLACK_HTTP_PATHS.commands
	);
}

function notReady(reason: string): Response {
	return new Response(JSON.stringify({ error: reason }), {
		status: 503,
		headers: { "content-type": "application/json" },
	});
}
