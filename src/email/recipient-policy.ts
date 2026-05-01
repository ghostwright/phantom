// Phase 10 PR 10-3: recipient-policy gate. The EmailTool consults this
// module before every Resend POST to decide whether the agent is allowed
// to email the requested recipient(s).
//
// Policy (architect §6.4):
//
//   - `owner` (default): only the owner email is allowed; everything else
//     is denied with `error_kind = "recipient_denied"`.
//   - `unrestricted`: any email is allowed. Operator-explicit opt-in only.
//   - (`workspace` is reserved for v1.5+ when workspace membership is
//     surfaced to the in-VM agent; rejected today as a config error.)
//
// Sources of the per-tenant policy decision:
//
//   - `PHANTOM_OWNER_EMAIL` env var: the owner address (always allowed
//     under `owner` mode). Plumbed by phantomd firstboot.
//   - `PHANTOM_EMAIL_RECIPIENTS_ALLOWED` env var: the policy mode. Values
//     accepted: `owner`, `unrestricted`, OR a comma-separated list of
//     additional addresses to allow on top of the owner. Empty / unset
//     defaults to `owner`. The literal `*` is accepted as a synonym for
//     `unrestricted` (back-compat with the architect's earlier draft).
//
// The gate evaluates EVERY address in `to`, `cc`, `bcc`. One denied
// address denies the whole send (architect §6.4 last paragraph): a
// partial-success would be confusing to the agent and would make
// idempotency harder.

export type RecipientPolicyMode = "owner" | "unrestricted" | "list";

export type RecipientPolicy = {
	mode: RecipientPolicyMode;
	ownerEmail: string;
	/** Additional allowed addresses when mode === "list". Always lowercase. */
	allowedList: ReadonlyArray<string>;
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string; deniedAddress: string };

/**
 * Parse the operator-supplied policy from raw env-var inputs. The parser is
 * deliberate about every value so a misconfigured operator gets a loud,
 * actionable error rather than a silent fallback to `unrestricted`.
 *
 * Throws on:
 *   - missing `ownerEmail`: a tenant without a known owner cannot email
 *     anyone safely; phantomd firstboot guarantees this is set.
 *   - the literal string "workspace" in the env (reserved for v1.5+).
 *
 * Defaults to `owner` mode when `recipientsAllowed` is unset / empty.
 */
export function parseRecipientPolicy(input: {
	ownerEmail: string | undefined;
	recipientsAllowed: string | undefined;
}): RecipientPolicy {
	const ownerEmail = (input.ownerEmail ?? "").trim().toLowerCase();
	if (!ownerEmail) {
		throw new Error("recipient-policy: PHANTOM_OWNER_EMAIL is required and must be a non-empty email");
	}
	if (!ownerEmail.includes("@")) {
		throw new Error(`recipient-policy: PHANTOM_OWNER_EMAIL must look like an email; got: ${ownerEmail}`);
	}

	const raw = (input.recipientsAllowed ?? "").trim();
	if (!raw) {
		return { mode: "owner", ownerEmail, allowedList: [] };
	}

	const lowered = raw.toLowerCase();

	if (lowered === "owner") {
		return { mode: "owner", ownerEmail, allowedList: [] };
	}
	if (lowered === "unrestricted" || lowered === "*") {
		return { mode: "unrestricted", ownerEmail, allowedList: [] };
	}
	if (lowered === "workspace") {
		// Reserved by the architect doc §6.4 footnote for v1.5+; reject today
		// so operators do not silently get owner-only behaviour when they
		// expect workspace-wide.
		throw new Error(
			"recipient-policy: 'workspace' mode is not supported in v1; use 'owner' or 'unrestricted' or a comma-separated allowlist",
		);
	}

	// Treat the value as a comma-separated allowlist of additional addresses.
	const parts = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
	if (parts.length === 0) {
		return { mode: "owner", ownerEmail, allowedList: [] };
	}
	for (const p of parts) {
		if (!p.includes("@")) {
			throw new Error(`recipient-policy: PHANTOM_EMAIL_RECIPIENTS_ALLOWED entry is not an email: ${p}`);
		}
	}
	return {
		mode: "list",
		ownerEmail,
		allowedList: Object.freeze(parts),
	};
}

/**
 * Evaluate one address against the policy. Case-insensitive. Returns a
 * structured decision so the caller can attribute denials in metrics.
 */
export function checkAddress(policy: RecipientPolicy, address: string): PolicyDecision {
	const candidate = address.trim().toLowerCase();
	if (!candidate) {
		return {
			allowed: false,
			reason: "empty address after trim",
			deniedAddress: address,
		};
	}

	if (policy.mode === "unrestricted") {
		return { allowed: true };
	}

	if (candidate === policy.ownerEmail) {
		return { allowed: true };
	}

	if (policy.mode === "list" && policy.allowedList.includes(candidate)) {
		return { allowed: true };
	}

	return {
		allowed: false,
		reason: policy.mode === "owner" ? "recipient not on owner allowlist" : "recipient not on operator allowlist",
		deniedAddress: address,
	};
}

/**
 * Evaluate every recipient (to, cc, bcc) against the policy. Returns the
 * first denial encountered; otherwise allowed. Order is deterministic
 * (to, then cc, then bcc) so the surfaced denial is reproducible across
 * test runs.
 */
export function checkRecipients(
	policy: RecipientPolicy,
	recipients: { to: string[]; cc?: string[]; bcc?: string[] },
): PolicyDecision {
	const all = [...recipients.to, ...(recipients.cc ?? []), ...(recipients.bcc ?? [])];
	for (const addr of all) {
		const decision = checkAddress(policy, addr);
		if (!decision.allowed) {
			return decision;
		}
	}
	return { allowed: true };
}
