import { describe, expect, test } from "bun:test";
import { checkAddress, checkRecipients, parseRecipientPolicy } from "../recipient-policy.ts";

const OWNER = "owner@example.com";

describe("parseRecipientPolicy", () => {
	test("default mode is owner when env unset", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: undefined });
		expect(policy.mode).toBe("owner");
		expect(policy.ownerEmail).toBe(OWNER);
	});

	test("default mode is owner when env empty string", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "" });
		expect(policy.mode).toBe("owner");
	});

	test("explicit 'owner' selects owner mode", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "owner" });
		expect(policy.mode).toBe("owner");
	});

	test("'unrestricted' selects unrestricted mode", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "unrestricted" });
		expect(policy.mode).toBe("unrestricted");
	});

	test("the literal '*' is accepted as a synonym for unrestricted", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "*" });
		expect(policy.mode).toBe("unrestricted");
	});

	test("comma-separated allowlist becomes list mode", () => {
		const policy = parseRecipientPolicy({
			ownerEmail: OWNER,
			recipientsAllowed: "alice@acme.com,bob@acme.com",
		});
		expect(policy.mode).toBe("list");
		expect(policy.allowedList).toEqual(["alice@acme.com", "bob@acme.com"]);
	});

	test("comma-list normalizes whitespace and case", () => {
		const policy = parseRecipientPolicy({
			ownerEmail: OWNER,
			recipientsAllowed: "  Alice@Acme.com , bob@acme.com  ",
		});
		expect(policy.allowedList).toEqual(["alice@acme.com", "bob@acme.com"]);
	});

	test("missing owner throws", () => {
		expect(() => parseRecipientPolicy({ ownerEmail: undefined, recipientsAllowed: undefined })).toThrow(
			/PHANTOM_OWNER_EMAIL/,
		);
	});

	test("non-email owner throws", () => {
		expect(() => parseRecipientPolicy({ ownerEmail: "not-an-email", recipientsAllowed: undefined })).toThrow(/email/);
	});

	test("'workspace' mode is rejected (reserved for v1.5+)", () => {
		expect(() => parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "workspace" })).toThrow(/workspace/);
	});

	test("non-email entry in allowlist throws", () => {
		expect(() => parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "alice@acme.com,not-an-email" })).toThrow(
			/not an email/,
		);
	});
});

describe("checkAddress", () => {
	test("owner mode allows owner exactly", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: undefined });
		expect(checkAddress(policy, OWNER).allowed).toBe(true);
	});

	test("owner mode is case-insensitive on owner match", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: undefined });
		expect(checkAddress(policy, "OWNER@example.com").allowed).toBe(true);
		expect(checkAddress(policy, "Owner@Example.COM").allowed).toBe(true);
	});

	test("owner mode denies anything else", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: undefined });
		const decision = checkAddress(policy, "stranger@example.com");
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.deniedAddress).toBe("stranger@example.com");
	});

	test("unrestricted mode allows arbitrary addresses", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "unrestricted" });
		expect(checkAddress(policy, "anyone@anywhere.com").allowed).toBe(true);
	});

	test("list mode allows owner and listed addresses", () => {
		const policy = parseRecipientPolicy({
			ownerEmail: OWNER,
			recipientsAllowed: "alice@acme.com,bob@acme.com",
		});
		expect(checkAddress(policy, OWNER).allowed).toBe(true);
		expect(checkAddress(policy, "alice@acme.com").allowed).toBe(true);
		expect(checkAddress(policy, "bob@acme.com").allowed).toBe(true);
	});

	test("list mode denies non-listed addresses", () => {
		const policy = parseRecipientPolicy({
			ownerEmail: OWNER,
			recipientsAllowed: "alice@acme.com",
		});
		expect(checkAddress(policy, "carol@acme.com").allowed).toBe(false);
	});

	test("empty address is denied even in unrestricted mode", () => {
		const policy = parseRecipientPolicy({ ownerEmail: OWNER, recipientsAllowed: "unrestricted" });
		expect(checkAddress(policy, "").allowed).toBe(false);
		expect(checkAddress(policy, "   ").allowed).toBe(false);
	});
});

describe("checkRecipients", () => {
	const policy = parseRecipientPolicy({
		ownerEmail: OWNER,
		recipientsAllowed: "alice@acme.com",
	});

	test("allows when every recipient is allowed", () => {
		expect(checkRecipients(policy, { to: [OWNER, "alice@acme.com"] }).allowed).toBe(true);
	});

	test("denies the whole send if any to address is denied", () => {
		const decision = checkRecipients(policy, { to: [OWNER, "stranger@x.com"] });
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.deniedAddress).toBe("stranger@x.com");
	});

	test("denies if a cc address is denied", () => {
		const decision = checkRecipients(policy, { to: [OWNER], cc: ["stranger@x.com"] });
		expect(decision.allowed).toBe(false);
	});

	test("denies if a bcc address is denied", () => {
		const decision = checkRecipients(policy, { to: [OWNER], bcc: ["stranger@x.com"] });
		expect(decision.allowed).toBe(false);
	});

	test("evaluation order is to -> cc -> bcc; first denial surfaces", () => {
		const decision = checkRecipients(policy, {
			to: ["denied-to@x.com"],
			cc: ["denied-cc@x.com"],
			bcc: ["denied-bcc@x.com"],
		});
		expect(decision.allowed).toBe(false);
		if (!decision.allowed) expect(decision.deniedAddress).toBe("denied-to@x.com");
	});
});
