import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
	REPLAY_WINDOW_MS,
	SIGNATURE_PREFIX,
	extractTeamId,
	signGatewayRequest,
	verifyGatewaySignature,
} from "../slack-gateway-verifier.ts";

const SECRET = "0123456789abcdef0123456789abcdef";

function makeSig(args: {
	forwardedAt: number;
	eventId: string;
	body: string | Buffer;
	secret?: string;
}): string {
	const raw = Buffer.isBuffer(args.body) ? args.body : Buffer.from(args.body);
	return signGatewayRequest({
		forwardedAt: args.forwardedAt,
		eventId: args.eventId,
		rawBody: raw,
		secret: args.secret ?? SECRET,
	});
}

describe("verifyGatewaySignature", () => {
	test("accepts a correctly-signed fresh request", () => {
		const now = 1714000000000;
		const body = '{"type":"event_callback","team_id":"T1"}';
		const sig = makeSig({ forwardedAt: now, eventId: "Ev1", body });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: String(now),
				eventId: "Ev1",
				raw: Buffer.from(body),
				secret: SECRET,
				now,
			}),
		).toBe(true);
	});

	test("rejects when X-Phantom-Signature is missing", () => {
		expect(
			verifyGatewaySignature({
				sigHeader: null,
				fwdHeader: "1714000000000",
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now: 1714000000000,
			}),
		).toBe(false);
	});

	test("rejects when signature lacks v1= prefix", () => {
		expect(
			verifyGatewaySignature({
				sigHeader: "abcdef0123456789",
				fwdHeader: "1714000000000",
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now: 1714000000000,
			}),
		).toBe(false);
	});

	test("rejects when X-Phantom-Forwarded-At is missing", () => {
		const sig = makeSig({ forwardedAt: 1714000000000, eventId: "Ev1", body: "{}" });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: null,
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now: 1714000000000,
			}),
		).toBe(false);
	});

	test("rejects when X-Phantom-Forwarded-At is non-numeric", () => {
		const sig = makeSig({ forwardedAt: 1714000000000, eventId: "Ev1", body: "{}" });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: "not-a-number",
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now: 1714000000000,
			}),
		).toBe(false);
	});

	test("rejects when X-Phantom-Forwarded-At is more than 5 minutes old", () => {
		const past = 1714000000000;
		const now = past + REPLAY_WINDOW_MS + 1;
		const sig = makeSig({ forwardedAt: past, eventId: "Ev1", body: "{}" });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: String(past),
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	test("rejects when X-Phantom-Forwarded-At is more than 5 minutes in the future", () => {
		const now = 1714000000000;
		const future = now + REPLAY_WINDOW_MS + 1;
		const sig = makeSig({ forwardedAt: future, eventId: "Ev1", body: "{}" });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: String(future),
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	test("rejects on tampered body (same headers, different bytes)", () => {
		const now = 1714000000000;
		const body = '{"team_id":"T1"}';
		const sig = makeSig({ forwardedAt: now, eventId: "Ev1", body });
		const tampered = '{"team_id":"T2"}';
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: String(now),
				eventId: "Ev1",
				raw: Buffer.from(tampered),
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	test("rejects when computed digest uses a different signing secret", () => {
		const now = 1714000000000;
		const body = "{}";
		const sig = makeSig({ forwardedAt: now, eventId: "Ev1", body, secret: "wrong-secret" });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: String(now),
				eventId: "Ev1",
				raw: Buffer.from(body),
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	test("rejects when presented digest length does not match", () => {
		const now = 1714000000000;
		expect(
			verifyGatewaySignature({
				sigHeader: `${SIGNATURE_PREFIX}deadbeef`,
				fwdHeader: String(now),
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	test("rejects when presented digest is not valid hex", () => {
		const now = 1714000000000;
		// 64 chars but with a non-hex 'z'
		const bogus = "z".repeat(64);
		expect(
			verifyGatewaySignature({
				sigHeader: `${SIGNATURE_PREFIX}${bogus}`,
				fwdHeader: String(now),
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
				now,
			}),
		).toBe(false);
	});

	test("uses Date.now() when caller omits the now argument", () => {
		// We cannot inject Date.now without overrides, but we can assert that a
		// fresh signature with forwardedAt=Date.now() passes when `now` is omitted.
		const stamp = Date.now();
		const sig = makeSig({ forwardedAt: stamp, eventId: "Ev1", body: "{}" });
		expect(
			verifyGatewaySignature({
				sigHeader: sig,
				fwdHeader: String(stamp),
				eventId: "Ev1",
				raw: Buffer.from("{}"),
				secret: SECRET,
			}),
		).toBe(true);
	});

	test("canonical string matches the documented `<at>:<eventId>:<body>` shape", () => {
		const now = 1714000000000;
		const body = "raw bytes";
		const expected = SIGNATURE_PREFIX + createHmac("sha256", SECRET).update(`${now}:Ev1:${body}`).digest("hex");
		expect(makeSig({ forwardedAt: now, eventId: "Ev1", body })).toBe(expected);
	});
});

describe("extractTeamId", () => {
	test("returns top-level team_id from JSON", () => {
		const body = Buffer.from('{"team_id":"T9TK3CUKW","event":{"type":"app_mention"}}');
		expect(extractTeamId(body, "application/json")).toBe("T9TK3CUKW");
	});

	test("returns nested team.id from JSON when team_id absent", () => {
		const body = Buffer.from('{"team":{"id":"T9TK3CUKW","domain":"acme"}}');
		expect(extractTeamId(body, "application/json")).toBe("T9TK3CUKW");
	});

	test("returns team.id from urlencoded interactivity payload", () => {
		const payload = JSON.stringify({
			type: "block_actions",
			team: { id: "T9TK3CUKW", domain: "acme" },
		});
		const body = Buffer.from(`payload=${encodeURIComponent(payload)}`);
		expect(extractTeamId(body, "application/x-www-form-urlencoded")).toBe("T9TK3CUKW");
	});

	test("returns undefined for malformed JSON", () => {
		expect(extractTeamId(Buffer.from("not json"), "application/json")).toBeUndefined();
	});

	test("returns undefined when urlencoded body has no payload", () => {
		expect(extractTeamId(Buffer.from("foo=bar"), "application/x-www-form-urlencoded")).toBeUndefined();
	});

	test("returns undefined when urlencoded payload is malformed JSON", () => {
		expect(extractTeamId(Buffer.from("payload=not-json"), "application/x-www-form-urlencoded")).toBeUndefined();
	});

	test("returns undefined when team_id is non-string", () => {
		const body = Buffer.from('{"team_id":12345}');
		expect(extractTeamId(body, "application/json")).toBeUndefined();
	});
});
