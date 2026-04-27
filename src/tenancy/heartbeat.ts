// Phase B.1.4: in-VM Phantom self-attestation to phantomd's metadata gateway.
//
// Two best-effort POSTs the agent fires after key boot milestones:
//
//   reportAgentReady      after the Slack channel is registered, telling
//                         phantomd's WaitTenantReady RPC to unblock so
//                         phantom-control can flip the wizard out of the
//                         "waiting_for_agent_ready" phase.
//
//   reportFirstDmSent     after the synthetic introduction DM is delivered
//                         to the installer, telling phantomd to persist
//                         tenants.first_dm_at so phantom-control can flip
//                         applications.status to active.
//
// Wire shape matches phantomd's tenant_status_handler.go exactly. Both
// routes return 204 on success; phantomd parses the JSON envelope and
// records audit fields. Source-IP authn is enforced at the gateway, so
// we do not sign the body or pass any tenant identifier here.
//
// Best-effort posture: a network or 5xx failure logs and continues. The
// canary's WaitTenantReady timeout is the operator-visible signal if
// agent_ready never lands; an absent first_dm_sent surfaces as
// failed_first_dm in phantom-control's poll loop. Throwing here would
// crash phantom for a transient gateway hiccup, which is a worse user
// outcome than a logged warning + retry-button-driven recovery.

const AGENT_READY_PATH = "/v1/tenant_status/agent_ready";
const FIRST_DM_SENT_PATH = "/v1/tenant_status/first_dm_sent";

const LOG_TAG = "heartbeat";

// FetchImpl mirrors the global fetch signature so tests can substitute a
// recording double. We deliberately avoid `typeof fetch` here because the
// global fetch type in @types/bun is broader than we need; a narrow alias
// keeps the test mocks tight.
export type FetchImpl = (input: string, init: RequestInit) => Promise<Response>;

export type AgentReadyOptions = {
	metadataBaseUrl: string;
	transport: string;
	fetchImpl?: FetchImpl;
};

export type FirstDmSentOptions = {
	metadataBaseUrl: string;
	slackMessageTs: string;
	fetchImpl?: FetchImpl;
};

/**
 * POST /v1/tenant_status/agent_ready. Body shape: { transport: "<value>" }.
 *
 * phantomd accepts an empty body, but we always include the transport so
 * the operator's audit log records whether the tenant booted in http or
 * socket mode (today only http hits this code path, but the field is
 * forward-compatible per phantomd's gateway comment).
 */
export async function reportAgentReady(opts: AgentReadyOptions): Promise<void> {
	const url = `${trimTrailingSlash(opts.metadataBaseUrl)}${AGENT_READY_PATH}`;
	const body = JSON.stringify({ transport: opts.transport });
	await postBestEffort(opts.fetchImpl, url, body, "agent_ready");
}

/**
 * POST /v1/tenant_status/first_dm_sent. Body shape: { slack_message_ts: "<ts>" }.
 *
 * phantomd's handler 400s on a missing or empty slack_message_ts. We do
 * not call this with an empty ts; the slack-http-receiver gates the call
 * on a non-null message_ts returned from chat.postMessage.
 */
export async function reportFirstDmSent(opts: FirstDmSentOptions): Promise<void> {
	if (!opts.slackMessageTs) {
		// Defensive: caller must pass a real ts. Logging here makes the
		// misuse visible without escalating to a thrown error that could
		// derail the agent's startup path.
		console.warn(`[${LOG_TAG}] first_dm_sent called with empty slack_message_ts; skipping`);
		return;
	}
	const url = `${trimTrailingSlash(opts.metadataBaseUrl)}${FIRST_DM_SENT_PATH}`;
	const body = JSON.stringify({ slack_message_ts: opts.slackMessageTs });
	await postBestEffort(opts.fetchImpl, url, body, "first_dm_sent");
}

async function postBestEffort(
	fetchImpl: FetchImpl | undefined,
	url: string,
	body: string,
	route: string,
): Promise<void> {
	const fn = fetchImpl ?? (globalThis.fetch as FetchImpl);
	try {
		const res = await fn(url, {
			method: "POST",
			body,
			headers: { "content-type": "application/json" },
		});
		if (!res.ok) {
			console.warn(`[${LOG_TAG}] ${route} returned HTTP ${res.status}`);
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		console.warn(`[${LOG_TAG}] ${route} failed: ${msg}`);
	}
}

// trimTrailingSlash protects against METADATA_BASE_URL=http://host/
// producing a doubled slash when concatenated with our paths. The
// metadata gateway's mux is path-strict (handleAgentReady only matches
// the exact path) so a doubled slash 404s.
function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}
