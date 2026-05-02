// Unit tests for the persona work-plan catalog. Pins:
//   - Every locked persona_id (slice 16d's seven) is present in
//     WORK_PLANS and PERSONA_WORK_PLAN_IDS.
//   - Every required field on the PersonaWorkPlan shape is filled per
//     entry; no entry is missing default_pulls, signal_patterns,
//     default_draft_kinds, max_drafts, intro_line, footer_line,
//     ttd_target_seconds, ttd_hard_cap_seconds, expected_draft_count_*,
//     required_integrations, fallback_dm_text.
//   - Every required_integrations entry is one of the allowed
//     integration names.
//   - Every signal_patterns / default_draft_kinds list is non-empty.
//   - filterIntegrationsByGrants returns the intersection.
//   - getPersonaWorkPlan handles unknown / undefined / empty inputs.

import { describe, expect, test } from "bun:test";
import { PERSONA_WORK_PLAN_IDS, WORK_PLANS, filterIntegrationsByGrants, getPersonaWorkPlan } from "../work-plans.ts";

const LOCKED_IDS = [
	"sdr-lilian",
	"eng-cos-marcus",
	"am-sloane",
	"bdr-theo",
	"sales-vp-priya",
	"gtm-eng-ryan",
	"founder-asst-adrian",
] as const;

const ALLOWED_INTEGRATIONS = new Set([
	"slack",
	"github",
	"calendar",
	"linear",
	"hubspot",
	"gmail",
	"notion",
	"slack-channel",
	"slack-dm",
]);

describe("persona work plans", () => {
	test("PERSONA_WORK_PLAN_IDS matches the locked seven in canonical order", () => {
		expect([...PERSONA_WORK_PLAN_IDS]).toEqual([...LOCKED_IDS]);
	});

	test("WORK_PLANS has exactly 7 entries", () => {
		expect(Object.keys(WORK_PLANS)).toHaveLength(7);
		for (const id of LOCKED_IDS) {
			expect(Object.keys(WORK_PLANS)).toContain(id);
		}
	});

	test("every persona has all required fields", () => {
		for (const id of LOCKED_IDS) {
			const plan = WORK_PLANS[id];
			expect(plan.persona_id).toBe(id);
			expect(plan.default_pulls.length).toBeGreaterThan(0);
			expect(plan.signal_patterns.length).toBeGreaterThan(0);
			expect(plan.default_draft_kinds.length).toBeGreaterThan(0);
			expect(plan.max_drafts).toBeGreaterThan(0);
			expect(plan.intro_line.length).toBeGreaterThan(0);
			expect(plan.footer_line.length).toBeGreaterThan(0);
			expect(plan.ttd_target_seconds).toBeGreaterThan(0);
			expect(plan.ttd_hard_cap_seconds).toBeGreaterThanOrEqual(plan.ttd_target_seconds);
			expect(plan.expected_draft_count_max).toBeGreaterThanOrEqual(plan.expected_draft_count_min);
			expect(plan.required_integrations.length).toBeGreaterThan(0);
			expect(plan.fallback_dm_text.length).toBeGreaterThan(0);
		}
	});

	test("every required_integrations entry is from the allowed set", () => {
		for (const id of LOCKED_IDS) {
			const plan = WORK_PLANS[id];
			for (const integ of plan.required_integrations) {
				expect(ALLOWED_INTEGRATIONS).toContain(integ);
			}
		}
	});

	test("every default_pull source is from the allowed set", () => {
		for (const id of LOCKED_IDS) {
			const plan = WORK_PLANS[id];
			for (const pull of plan.default_pulls) {
				expect(ALLOWED_INTEGRATIONS).toContain(pull.source);
				expect(pull.timeout_ms).toBeGreaterThan(0);
				expect(pull.max_rows).toBeGreaterThan(0);
				expect(pull.query.length).toBeGreaterThan(0);
			}
		}
	});

	test("ttd_hard_cap_seconds is the architect-locked 60 across all personas", () => {
		for (const id of LOCKED_IDS) {
			expect(WORK_PLANS[id].ttd_hard_cap_seconds).toBe(60);
		}
	});

	test("intro_line ends with a period (matches '${name} here.' shape)", () => {
		for (const id of LOCKED_IDS) {
			expect(WORK_PLANS[id].intro_line).toMatch(/^[A-Z][a-z]+ here\.$/);
		}
	});

	test("no em dashes in any persona text field", () => {
		// The voice contract bans em dashes anywhere. Every fallback DM,
		// every intro_line, every footer_line is checked.
		const emDash = /—/;
		for (const id of LOCKED_IDS) {
			const plan = WORK_PLANS[id];
			expect(plan.intro_line).not.toMatch(emDash);
			expect(plan.footer_line).not.toMatch(emDash);
			expect(plan.fallback_dm_text).not.toMatch(emDash);
			for (const pattern of plan.signal_patterns) {
				expect(pattern).not.toMatch(emDash);
			}
		}
	});

	test("getPersonaWorkPlan returns the correct plan for a known id", () => {
		const plan = getPersonaWorkPlan("sdr-lilian");
		expect(plan?.persona_id).toBe("sdr-lilian");
		expect(plan?.intro_line).toBe("Lilian here.");
	});

	test("getPersonaWorkPlan returns undefined for unknown / empty / undefined", () => {
		expect(getPersonaWorkPlan(undefined)).toBeUndefined();
		expect(getPersonaWorkPlan("")).toBeUndefined();
		expect(getPersonaWorkPlan("   ")).toBeUndefined();
		expect(getPersonaWorkPlan("not-a-persona")).toBeUndefined();
		// Drift-canary: the architect doc carried "sales-leader-priya" in
		// the §2.5 narrative; the canonical fixture corrects it to
		// "sales-vp-priya". The lookup must reject the typo.
		expect(getPersonaWorkPlan("sales-leader-priya")).toBeUndefined();
	});

	test("getPersonaWorkPlan trims whitespace and matches", () => {
		expect(getPersonaWorkPlan("  sdr-lilian  ")?.persona_id).toBe("sdr-lilian");
	});
});

describe("filterIntegrationsByGrants", () => {
	test("returns the intersection of required and available", () => {
		expect(filterIntegrationsByGrants(["slack", "github"], ["slack", "calendar"])).toEqual(["slack"]);
	});

	test("is case-insensitive", () => {
		expect(filterIntegrationsByGrants(["Slack", "github"], ["SLACK", "Calendar"])).toEqual(["Slack"]);
	});

	test("returns empty when no overlap", () => {
		expect(filterIntegrationsByGrants(["github"], ["slack"])).toEqual([]);
	});

	test("preserves required-side ordering", () => {
		expect(filterIntegrationsByGrants(["github", "slack", "linear"], ["slack", "github"])).toEqual(["github", "slack"]);
	});

	test("returns empty for empty inputs", () => {
		expect(filterIntegrationsByGrants([], [])).toEqual([]);
		expect(filterIntegrationsByGrants(["slack"], [])).toEqual([]);
		expect(filterIntegrationsByGrants([], ["slack"])).toEqual([]);
	});
});
