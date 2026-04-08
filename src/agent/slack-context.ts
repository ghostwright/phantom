import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped Slack context for the current agent turn.
 *
 * Populated by the channel router when a Slack-origin message enters the
 * runtime, and read by in-process MCP tool handlers that need to target the
 * operator's originating message/thread without relying on the agent to
 * forward the IDs through tool arguments. This is the minimum-surface
 * plumbing that lets tools (e.g. phantom_loop) auto-fill channel/thread when
 * the agent omits them.
 *
 * Non-Slack turns (telegram, email, webhook, cli, scheduled triggers) leave
 * the store unset; consumers must treat `getStore()` as possibly undefined.
 */
export type SlackContext = {
	slackChannelId: string;
	slackThreadTs: string;
	slackMessageTs: string;
};

export const slackContextStore = new AsyncLocalStorage<SlackContext>();
