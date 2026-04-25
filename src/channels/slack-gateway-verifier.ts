// Phase 5b: HMAC verifier for the gateway -> tenant Phantom forwarding
// hop. The phantom-slack-events gateway signs every forwarded request with
// `HMAC-SHA256(gatewaySigningSecret, "<forwardedAt>:<eventId>:<rawBody>")`.
// The tenant Phantom verifies the signature here before letting the request
// reach Bolt, and the parsed team_id is checked separately by the channel.
//
// We keep this file laser-focused on the verifier so the receiver itself
// stays under the 300-line budget. Keeping the verifier pure (no `this`,
// no I/O, no time-of-day side channels beyond the explicit `now` argument)
// makes the unit tests cheap and the failure modes obvious.

import { createHmac, timingSafeEqual } from "node:crypto";

export const REPLAY_WINDOW_MS = 5 * 60 * 1000;
export const SIGNATURE_PREFIX = "v1=";

export type VerifyInput = {
	sigHeader: string | null;
	fwdHeader: string | null;
	eventId: string | null;
	raw: Buffer;
	secret: string;
	now?: number;
};

/**
 * Returns true iff the gateway's signature, replay window, and HMAC digest
 * all check out. Never throws; never logs; never includes plaintext.
 *
 * Failure modes that return false:
 *   - missing or non-`v1=` X-Phantom-Signature
 *   - missing or non-numeric X-Phantom-Forwarded-At
 *   - timestamp more than 5 minutes off from `now` (in either direction;
 *     handles clock skew on the gateway and on this VM)
 *   - presented signature has odd length, contains non-hex chars, or fails
 *     the byte-length pre-check below (Node's hex decoder silently truncates
 *     on malformed input, so a malformed signature produces a wrong-length
 *     buffer that this check rejects)
 *   - constant-time compare returns inequality
 */
export function verifyGatewaySignature(input: VerifyInput): boolean {
	const { sigHeader, fwdHeader, eventId, raw, secret } = input;
	const now = input.now ?? Date.now();

	if (!sigHeader || !sigHeader.startsWith(SIGNATURE_PREFIX)) return false;
	if (!fwdHeader) return false;

	const fwdAt = Number.parseInt(fwdHeader, 10);
	if (!Number.isFinite(fwdAt)) return false;
	if (Math.abs(now - fwdAt) > REPLAY_WINDOW_MS) return false;

	const canonical = `${fwdHeader}:${eventId ?? ""}:${raw.toString("utf-8")}`;
	const expected = createHmac("sha256", secret).update(canonical).digest("hex");
	const presented = sigHeader.slice(SIGNATURE_PREFIX.length);

	const expBuf = Buffer.from(expected, "hex");
	const presBuf = Buffer.from(presented, "hex");
	if (presBuf.length !== expBuf.length) return false;
	return timingSafeEqual(expBuf, presBuf);
}

/**
 * Helper for tests and for the receiver to compute the canonical signature
 * the gateway would emit. Exported so the test suite can sign a forged
 * request body without re-implementing the canonical string format.
 */
export function signGatewayRequest(args: {
	forwardedAt: number;
	eventId: string;
	rawBody: Buffer;
	secret: string;
}): string {
	const canonical = `${args.forwardedAt}:${args.eventId}:${args.rawBody.toString("utf-8")}`;
	const mac = createHmac("sha256", args.secret).update(canonical).digest("hex");
	return `${SIGNATURE_PREFIX}${mac}`;
}

/**
 * Extract `team_id` from a forwarded request body. Both Slack events
 * (application/json) and interactivity payloads
 * (application/x-www-form-urlencoded with a JSON `payload` parameter) carry
 * the team identifier, but in different shapes.
 *
 * Returns undefined when the body shape cannot be parsed; the caller decides
 * what undefined means (we treat it as "do not enforce" because some pings
 * legitimately have no team_id).
 */
export function extractTeamId(raw: Buffer, contentType: string): string | undefined {
	const lower = contentType.toLowerCase();
	const text = raw.toString("utf-8");
	if (lower.includes("application/x-www-form-urlencoded")) {
		const params = new URLSearchParams(text);
		const payload = params.get("payload");
		if (!payload) return undefined;
		try {
			const parsed = JSON.parse(payload) as Record<string, unknown>;
			return readTeamId(parsed);
		} catch {
			return undefined;
		}
	}
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		return readTeamId(parsed);
	} catch {
		return undefined;
	}
}

function readTeamId(parsed: Record<string, unknown>): string | undefined {
	if (typeof parsed.team_id === "string") return parsed.team_id;
	const team = parsed.team as Record<string, unknown> | undefined;
	if (team && typeof team.id === "string") return team.id;
	return undefined;
}
