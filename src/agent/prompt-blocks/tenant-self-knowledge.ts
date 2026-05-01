// Tenant self-knowledge overlay (Phase 9, mission v1 sequencing step 4).
//
// Purpose: tell the agent who it is, who it works for, where it lives, and
// what catalog of integrations it has been granted. Today the agent learns
// its public URL passively through buildIdentity / buildEnvironment, but it
// does NOT know its tenant slug, owner identity, dashboard URL, runtime, or
// model. Without this overlay the agent cannot reason about "you are the
// Phantom assigned to <user>" when a sidekick or operator asks; it cannot
// hand its own URL back to the user; it cannot reference its dashboard.
//
// The overlay slots in between buildIdentity and buildEnvironment in the
// assembled prompt so the agent reads its own identity facts before the
// environment description. The block is purely additive: every line is
// gated on a real env var so unset values silently disappear (single-tenant
// or laptop dev runs see no change to today's prompt).
//
// Source of the env vars (verified 2026-05-01):
//   PHANTOM_TENANT_ID, PHANTOM_TENANT_SLUG, PHANTOM_OWNER_EMAIL come from
//   phantomd's firstbootStep at internal/state/orchestrator.go:623-662 via
//   internal/firstboot/firstboot.go:263-292 (writeEnvFile). phantom-firstboot
//   stamps them into /etc/default/phantom which phantom.service sources via
//   EnvironmentFile=, so they survive in process.env post-firstboot.
//
//   PHANTOM_OWNER_NAME and PHANTOM_DOMAIN are queued in phantomd CLAUDE.md
//   as a one-line addition to firstbootStep; the overlay reads them
//   defensively today so this Phantom-side PR ships without waiting on the
//   phantomd-side wiring.
//
//   PHANTOM_DASHBOARD_URL is set as an Environment= line in
//   phantom-rootfs/systemd/phantom.service:34 (currently
//   https://ghostwright.dev/phantom/dashboard, will move to
//   https://app.ghostwright.dev when Phase 3 lands).
//
//   PHANTOM_AGENT_RUNTIME comes from phantom.service:40 (Phase 0 hardcode
//   today; Phase 1 wizard injects per-tenant via tenant.env).
//   PHANTOM_MODEL comes from tenant.env when phantomd's firstbootStep
//   ($req.Model$) is non-empty; otherwise the rootfs phantom.yaml default
//   ("claude-sonnet-4-6") wins through loader.ts.
//
//   PHANTOM_GRANTED_INTEGRATIONS and PHANTOM_CHANNEL_ALLOWLIST are hooks
//   that today's tenant.env does NOT carry. They land in Phase 7
//   (integration platform) and Phase 8b (Slack channel allowlist) per
//   master plan section 3. The overlay reads them defensively so the
//   shape is in place when phantomd starts emitting them.
//
// Caching note: process.env values are stable for the lifetime of the
// process (we never mutate the relevant keys after startup). The
// assembler invokes this builder once per query() to keep the contract
// consistent with the other prompt blocks. The cost is negligible
// (few-microsecond string concat against a tiny env shape) and the
// alternative (capture-once at startup) costs flexibility for future
// tests that want to vary the env per-call.

export interface TenantSelfKnowledgeEnv {
	tenantSlug?: string;
	tenantId?: string;
	ownerEmail?: string;
	ownerName?: string;
	domain?: string;
	dashboardUrl?: string;
	agentRuntime?: string;
	model?: string;
	grantedIntegrations?: string;
	channelAllowlist?: string;
}

// Read every relevant env var into a plain shape so tests can build the
// same input without mutating process.env. The reader trims and treats
// the empty string as "unset" so a downstream env injector that emits
// PHANTOM_OWNER_NAME= (no value) does not produce a half-finished line.
export function readTenantSelfKnowledgeEnv(env: NodeJS.ProcessEnv = process.env): TenantSelfKnowledgeEnv {
	return {
		tenantSlug: cleanString(env.PHANTOM_TENANT_SLUG),
		tenantId: cleanString(env.PHANTOM_TENANT_ID),
		ownerEmail: cleanString(env.PHANTOM_OWNER_EMAIL),
		ownerName: cleanString(env.PHANTOM_OWNER_NAME),
		domain: cleanString(env.PHANTOM_DOMAIN),
		dashboardUrl: cleanString(env.PHANTOM_DASHBOARD_URL),
		agentRuntime: cleanString(env.PHANTOM_AGENT_RUNTIME),
		model: cleanString(env.PHANTOM_MODEL),
		grantedIntegrations: cleanString(env.PHANTOM_GRANTED_INTEGRATIONS),
		channelAllowlist: cleanString(env.PHANTOM_CHANNEL_ALLOWLIST),
	};
}

// Build the overlay text from a TenantSelfKnowledgeEnv shape. Returns the
// empty string when there is nothing to say, so the caller can skip the
// section entirely (no leading or trailing blank lines polluting the
// surrounding blocks). Order matches the way a colleague would introduce
// themselves: identity first, then where to reach them, then capabilities,
// then the optional catalog.
//
// The builder defensively re-cleans every string field so a caller that
// hand-builds the shape (rather than going through readTenantSelfKnowledgeEnv)
// still gets the same whitespace and empty-string handling. The cleaning is
// idempotent: a value that is already trimmed is returned unchanged.
export function buildTenantSelfKnowledge(envShape: TenantSelfKnowledgeEnv = readTenantSelfKnowledgeEnv()): string {
	const e: TenantSelfKnowledgeEnv = {
		tenantSlug: cleanString(envShape.tenantSlug),
		tenantId: cleanString(envShape.tenantId),
		ownerEmail: cleanString(envShape.ownerEmail),
		ownerName: cleanString(envShape.ownerName),
		domain: cleanString(envShape.domain),
		dashboardUrl: cleanString(envShape.dashboardUrl),
		agentRuntime: cleanString(envShape.agentRuntime),
		model: cleanString(envShape.model),
		grantedIntegrations: cleanString(envShape.grantedIntegrations),
		channelAllowlist: cleanString(envShape.channelAllowlist),
	};

	// If we have nothing tenant-specific to say, return empty so the
	// assembler drops the block instead of emitting a stub heading.
	const hasAnything = Boolean(
		e.tenantSlug ||
			e.ownerEmail ||
			e.ownerName ||
			e.domain ||
			e.dashboardUrl ||
			e.agentRuntime ||
			e.model ||
			e.grantedIntegrations ||
			e.channelAllowlist,
	);
	if (!hasAnything) return "";

	const lines: string[] = ["# Who You Are In This Workspace", ""];

	// Owner + tenant slug. Compose into one sentence so the agent reads
	// "you are the Phantom assigned to X's workspace `slug`" as a unit.
	const ownerPhrase = composeOwnerPhrase(e.ownerName, e.ownerEmail);
	if (ownerPhrase && e.tenantSlug) {
		lines.push(`You are the Phantom assigned to ${ownerPhrase}'s workspace \`${e.tenantSlug}\`.`);
	} else if (ownerPhrase) {
		lines.push(`You are the Phantom assigned to ${ownerPhrase}'s workspace.`);
	} else if (e.tenantSlug) {
		lines.push(`You are the Phantom for workspace \`${e.tenantSlug}\`.`);
	}

	// Per-tenant home URL. Prefer the explicit PHANTOM_DOMAIN injection
	// because it is the canonical operator-set value; fall back to deriving
	// from slug + ghostwright.dev only when domain is unset and slug is
	// present (defensive against intermediate phantomd versions that have
	// not landed the PHANTOM_DOMAIN injection yet).
	const homeUrl = composeHomeUrl(e.domain, e.tenantSlug);
	if (homeUrl) {
		lines.push(`Your home URL is ${homeUrl}. The user reaches you here.`);
	}

	// Dashboard URL: where the operator manages the Phantom from outside
	// the chat surface. Today this points at ghostwright.dev/phantom/dashboard;
	// after Phase 3 it points at app.ghostwright.dev.
	if (e.dashboardUrl) {
		lines.push(`Your dashboard control surface is ${e.dashboardUrl}.`);
	}

	// Runtime + model in one line because they are tightly coupled
	// (Murph runtime selects a per-provider model, Anthropic-runtime
	// pins the Anthropic model directly). Skip the line entirely when
	// neither is known.
	const runtimeLine = composeRuntimeLine(e.agentRuntime, e.model);
	if (runtimeLine) {
		lines.push(runtimeLine);
	}

	// Granted integrations hook (Phase 7). When phantomd starts emitting
	// PHANTOM_GRANTED_INTEGRATIONS as a comma-separated list, the agent
	// gets a one-line summary of its scoped integrations. Until then
	// this stays silent.
	const grants = formatList(e.grantedIntegrations);
	if (grants.length > 0) {
		lines.push(`You have been granted these integrations: ${grants.join(", ")}.`);
	}

	// Channel allowlist hook (Phase 8b). Same shape as grantedIntegrations:
	// comma-separated channel identifiers (e.g. C0123,C0456). Stays silent
	// until phantomd emits it.
	const channels = formatList(e.channelAllowlist);
	if (channels.length > 0) {
		lines.push(`Your Slack channel allowlist: ${channels.join(", ")}.`);
	}

	return lines.join("\n");
}

// Compose a human-readable phrase for the owner. Prefers "Name (email)" when
// both are known, falls back to either alone. Returns undefined when neither
// is present so the caller can decide how to introduce the workspace without
// an owner.
function composeOwnerPhrase(ownerName: string | undefined, ownerEmail: string | undefined): string | undefined {
	if (ownerName && ownerEmail) return `${ownerName} (${ownerEmail})`;
	if (ownerName) return ownerName;
	if (ownerEmail) return ownerEmail;
	return undefined;
}

// Compose the canonical https URL for the agent's per-tenant origin. Prefers
// PHANTOM_DOMAIN when set (operator-controlled, includes any future custom
// domain). Otherwise derives `https://<slug>.phantom.ghostwright.dev` from
// the slug, which matches phantom-cloud-deploy's wildcard DNS-01 invariant.
// Returns undefined if we have neither (single-tenant dev mode).
function composeHomeUrl(domain: string | undefined, tenantSlug: string | undefined): string | undefined {
	if (domain) {
		const trimmed = domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
		if (trimmed) return `https://${trimmed}`;
	}
	if (tenantSlug) {
		return `https://${tenantSlug}.phantom.ghostwright.dev`;
	}
	return undefined;
}

// Compose the runtime + model line. Both fields are optional individually;
// emit whatever is known. Capitalize the runtime kind for readability.
function composeRuntimeLine(agentRuntime: string | undefined, model: string | undefined): string | undefined {
	const parts: string[] = [];
	if (agentRuntime) parts.push(`Runtime: ${agentRuntime}.`);
	if (model) parts.push(`Model: ${model}.`);
	if (parts.length === 0) return undefined;
	return parts.join(" ");
}

// Trim and reject empty strings as "unset". Returns undefined for missing
// values so consumers can use simple boolean checks.
function cleanString(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

// Parse a comma-separated env var into a clean list. Returns [] for missing
// or all-empty input so the caller can use a length check instead of a null
// check.
function formatList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}
