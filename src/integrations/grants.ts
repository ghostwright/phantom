// Integration grant reader for the in-VM phantom. Resolves the list of
// integrations the tenant has connected and the persona may consume
// during do_first_hour_of_work (architect §4.1, §4.4).
//
// v1 reads PHANTOM_GRANTED_INTEGRATIONS, the comma-separated env var
// stamped by phantomd firstboot via tenant.env, then sourced into the
// process via phantom.service's EnvironmentFile. Phase 9 self-knowledge
// (src/agent/prompt-blocks/tenant-self-knowledge.ts) already consumes
// the same env var; this module is the canonical reader for the
// runner-facing path.
//
// Future (slice 22+): swap the env-var reader for a metadata-gateway
// HTTP call to GET /v1/agents/<agent_id>/grants so the list refreshes
// without a process restart. The contract is the same: a string[] of
// lowercase provider names. The runner consumes the result via
// readGrantedIntegrations(); the env path is the v1 default and the
// gateway path is opt-in via PHANTOM_GRANTS_FETCHER=gateway.

const ENV_VAR = "PHANTOM_GRANTED_INTEGRATIONS";

// Slack is granted by definition: the wizard's slot 10 install completes
// before phantom boots, so the bot is in the workspace and the agent
// has a DM channel. The architect doc §6.1 calls this out explicitly:
// "for all 7 personas, Slack is granted by definition." We surface it
// in the resolved list even when the env var omits it so a misconfigured
// firstboot does not falsely trip the no_integrations_granted DM for
// Slack-only personas.
const ALWAYS_GRANTED: readonly string[] = ["slack"];

export interface GrantsReaderDeps {
	env?: NodeJS.ProcessEnv;
}

// readGrantedIntegrations returns the list of integration names the
// tenant has connected, lowercased and deduplicated. Slack is always
// present in the result. Empty input yields ["slack"]. Whitespace-only
// or malformed entries are dropped silently.
export function readGrantedIntegrations(deps: GrantsReaderDeps = {}): string[] {
	const env = deps.env ?? process.env;
	const raw = (env[ENV_VAR] ?? "").trim();
	const parsed = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	return dedupeWithSlack(parsed);
}

function dedupeWithSlack(list: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of [...ALWAYS_GRANTED, ...list]) {
		if (seen.has(item)) continue;
		seen.add(item);
		out.push(item);
	}
	return out;
}
