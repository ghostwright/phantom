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
		// either a probe or a misconfigured forwarder. 503 makes the
		// distinction loud while still being a retryable signal upstream.
		return new Response("slack http channel not configured", { status: 503 });
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
