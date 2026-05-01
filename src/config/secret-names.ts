// Phase 10 PR 10-3: canonical mirror of phantomd's `AllowedSecretNames` for the
// secret names that the in-VM Phantom fetches via the metadata gateway. The
// allowlist itself lives in phantomd at `internal/secrets/types.go`; this file
// is the phantom-side mirror that callsites import so the wire-stable string
// has exactly one home in TypeScript.
//
// Cross-repo invariant: every entry in `AllowedSecretNamesMirror` MUST appear
// in phantomd's `AllowedSecretNames` map. The gateway maps `ErrInvalidName` to
// HTTP 404 (name-enumeration defense), so a drift between this list and
// phantomd's allowlist breaks tenant boot with no actionable error in the
// in-VM Phantom logs. The drift is caught by:
//
//   - phantomd's `TestIsAllowedName_AcceptsResendApiKey` (and the existing
//     symmetric `*_AcceptsSlackAppToken`, `*_AcceptsSlackGatewaySigningSecret`)
//   - phantom's `src/config/__tests__/secret-names.test.ts` and the existing
//     `src/channels/__tests__/slack-channel-factory.test.ts::AllowedSecretNamesMirror`
//
// The Phase 10 architect doc §3.5 (the mirror invariant) and §9.1 (the
// cross-repo allowlist table) describes the full mirror surface.
//
// Why this module exists separately from `slack-channel-factory.ts`: prior to
// Phase 10 the only consumers were Slack-related, so the mirror lived in
// `slack-channel-factory.ts`. Phase 10 adds `resend_api_key`, which is
// consumed by the email module not the Slack module; the mirror is now the
// shared concern of both. Keeping it here means future additions (Telegram
// secrets, webhook secrets, etc.) follow the same import without churning
// the slack-channel-factory module.

/**
 * Wire-stable secret name for the Resend transactional-email API key.
 *
 * This string MUST be exactly `"resend_api_key"`, byte-for-byte equal to:
 *   - phantomd `internal/secrets/types.go::AllowedSecretNames["resend_api_key"]`
 *   - phantom-control's `chainSeedResendKey` step (Phase 10 PR 10-2)
 *   - the architect doc §9.1 cross-repo allowlist table
 *
 * Drift on the literal string surfaces as HTTP 404 from the metadata gateway
 * (the gateway maps `ErrInvalidName` to 404 to defeat name enumeration),
 * which `key-fetcher.ts` surfaces as `error_kind = "key_unavailable"` to the
 * EmailTool. Source: `phantom-cloud-deploy/local/2026-05-01-phase10-resend-architect.md`
 * §3.4 + §3.5 + §9.1.
 */
export const RESEND_API_KEY_SECRET_NAME = "resend_api_key" as const;

/**
 * The phantom-side authoritative mirror of phantomd's `AllowedSecretNames`
 * map. Keep this list sorted in groups by purpose (Slack, Email, etc.) for
 * readability; the test that pins it against phantomd compares as a set, not
 * a sequence.
 *
 * Phase 8a addition (R7 dated 2026-04-30): `slack_app_token` joins the
 * Socket Mode pair, gating the WSS dial for self-installed agent #2+.
 *
 * Phase 10 addition (Resend transactional email, dated 2026-05-01):
 * `resend_api_key` joins the email module, fetched on demand by
 * `src/email/key-fetcher.ts`.
 */
export const AllowedSecretNamesMirror = Object.freeze([
	// Slack (Phase 5b + Phase 8a R7).
	"slack_bot_token",
	"slack_app_token",
	"slack_gateway_signing_secret",
	// Resend (Phase 10).
	RESEND_API_KEY_SECRET_NAME,
] as const);

export type AllowedSecretName = (typeof AllowedSecretNamesMirror)[number];
