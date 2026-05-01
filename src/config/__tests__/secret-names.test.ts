import { describe, expect, test } from "bun:test";
import { AllowedSecretNamesMirror, RESEND_API_KEY_SECRET_NAME } from "../secret-names.ts";

describe("RESEND_API_KEY_SECRET_NAME", () => {
	test("is exactly 'resend_api_key' (cross-repo wire-stable)", () => {
		// This string MUST match phantomd/internal/secrets/types.go
		// AllowedSecretNames["resend_api_key"]. Drift breaks tenant boot
		// with HTTP 404 (the gateway maps ErrInvalidName to 404).
		// See Phase 10 architect §3.5 + §9.1.
		expect(RESEND_API_KEY_SECRET_NAME).toBe("resend_api_key");
	});

	test("uses lowercase letters and underscores only (allowlist regex shape)", () => {
		expect(RESEND_API_KEY_SECRET_NAME).toMatch(/^[a-z_][a-z0-9_]*$/);
	});
});

describe("AllowedSecretNamesMirror", () => {
	test("includes resend_api_key (Phase 10)", () => {
		expect(AllowedSecretNamesMirror).toContain("resend_api_key");
	});

	test("includes the slack triple (audit-F1 + Phase 8a)", () => {
		expect(AllowedSecretNamesMirror).toContain("slack_bot_token");
		expect(AllowedSecretNamesMirror).toContain("slack_app_token");
		expect(AllowedSecretNamesMirror).toContain("slack_gateway_signing_secret");
	});

	test("entries are frozen (mutation is loud)", () => {
		expect(Object.isFrozen(AllowedSecretNamesMirror)).toBe(true);
	});

	test("every entry matches phantomd's allowlist regex", () => {
		const ALLOWED_NAME_RE = /^[a-z_][a-z0-9_]*$/;
		for (const name of AllowedSecretNamesMirror) {
			expect(name).toMatch(ALLOWED_NAME_RE);
		}
	});
});
