// Phase 5b: tenant Phantom fetches its non-secret identity from the host
// metadata gateway at boot. Identity is per-tenant context (tenant_id, slug,
// region, host_id, env) plus an optional `slack` subfield populated by
// phantom-control after the OAuth handshake. Secrets (bot token, gateway
// signing secret) live under /v1/secrets/<name> via Phase C; identity is
// the parallel non-secret path.
//
// Three invariants live here:
//   1. No body is included in error messages. The /v1/identity body is not
//      a secret, but error messages that quote response bodies tend to grow
//      teeth as schemas evolve. We keep error context to HTTP status only.
//   2. Schema is validated before the value is returned. A future field that
//      drifts from the documented shape produces a clear parse error rather
//      than a silent undefined-typed runtime hazard.
//   3. No cache. Identity is fetched once at boot. The caller holds the
//      result in process memory; rotation is an out-of-band operator action
//      via UpdateSlackIdentity gRPC followed by daemon restart.

export const DEFAULT_METADATA_BASE_URL = "http://169.254.169.254";

export type SlackIdentity = {
	teamId: string;
	installerUserId: string;
	teamName: string;
	installedAt: string;
};

export type TenantIdentity = {
	tenantId: string;
	tenantSlug: string;
	region: string;
	hostId: string;
	env: string;
	slack?: SlackIdentity;
};

export class MetadataIdentityFetcher {
	private readonly baseUrl: string;

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl;
	}

	async get(): Promise<TenantIdentity> {
		const url = `${this.baseUrl}/v1/identity`;

		let res: Response;
		try {
			res = await fetch(url, { method: "GET" });
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`metadata: fetch identity failed: ${msg}`);
		}

		if (res.status !== 200) {
			throw new Error(`metadata: fetch identity failed: HTTP ${res.status} ${res.statusText}`);
		}

		let parsed: unknown;
		try {
			parsed = await res.json();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`metadata: fetch identity failed: malformed JSON: ${msg}`);
		}

		return parseIdentity(parsed);
	}
}

function parseIdentity(raw: unknown): TenantIdentity {
	if (!raw || typeof raw !== "object") {
		throw new Error("metadata: identity response is not an object");
	}
	const obj = raw as Record<string, unknown>;

	const tenantId = requireString(obj, "tenant_id");
	const tenantSlug = requireString(obj, "tenant_slug");
	const region = optionalString(obj, "region") ?? "";
	const hostId = optionalString(obj, "host_id") ?? "";
	const env = optionalString(obj, "env") ?? "";

	const identity: TenantIdentity = {
		tenantId,
		tenantSlug,
		region,
		hostId,
		env,
	};

	if (obj.slack !== undefined && obj.slack !== null) {
		identity.slack = parseSlack(obj.slack);
	}

	return identity;
}

function parseSlack(raw: unknown): SlackIdentity {
	if (!raw || typeof raw !== "object") {
		throw new Error("metadata: identity.slack is not an object");
	}
	const obj = raw as Record<string, unknown>;
	return {
		teamId: requireString(obj, "team_id", "slack.team_id"),
		installerUserId: requireString(obj, "installer_user_id", "slack.installer_user_id"),
		teamName: requireString(obj, "team_name", "slack.team_name"),
		installedAt: requireString(obj, "installed_at", "slack.installed_at"),
	};
}

function requireString(obj: Record<string, unknown>, key: string, label?: string): string {
	const value = obj[key];
	if (typeof value !== "string") {
		throw new Error(`metadata: identity field ${label ?? key} is not a string`);
	}
	return value;
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
	const value = obj[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new Error(`metadata: identity field ${key} is not a string`);
	}
	return value;
}
