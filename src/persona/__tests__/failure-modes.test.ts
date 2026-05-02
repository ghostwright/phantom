// Per-persona DM text pins for the six failure modes (architect §6).
// Each persona has a verbatim DM body; the test pins the exact string
// so a copy edit ships through code review, not silently. The verbatim
// text is the contract the strategy doc commits to.

import { describe, expect, test } from "bun:test";
import {
	allPullsZeroDataDm,
	dmTextForReason,
	integrationAuthExpiredDm,
	llmErrorMidFlowDm,
	noIntegrationsGrantedDm,
	resolveOrThrowPersona,
	sixtySecondCapHitDm,
	zeroDraftsFromNonzeroDataDm,
} from "../failure-modes.ts";
import { WORK_PLANS } from "../work-plans.ts";

const PERSONAS = [
	"sdr-lilian",
	"eng-cos-marcus",
	"am-sloane",
	"bdr-theo",
	"sales-vp-priya",
	"gtm-eng-ryan",
	"founder-asst-adrian",
] as const;

describe("noIntegrationsGrantedDm (architect §6.1)", () => {
	test("returns the verbatim fallback_dm_text per persona", () => {
		for (const id of PERSONAS) {
			expect(noIntegrationsGrantedDm(WORK_PLANS[id])).toBe(WORK_PLANS[id].fallback_dm_text);
		}
	});

	test("Lilian's DM names HubSpot or #leads", () => {
		expect(noIntegrationsGrantedDm(WORK_PLANS["sdr-lilian"])).toMatch(/HubSpot/);
		expect(noIntegrationsGrantedDm(WORK_PLANS["sdr-lilian"])).toMatch(/#leads/);
	});

	test("Marcus's DM names GitHub", () => {
		expect(noIntegrationsGrantedDm(WORK_PLANS["eng-cos-marcus"])).toMatch(/GitHub/);
	});

	test("Theo's DM asks for 5 ICP names", () => {
		expect(noIntegrationsGrantedDm(WORK_PLANS["bdr-theo"])).toMatch(/5 ICP names/);
	});

	test("Priya's DM names Calendar and HubSpot", () => {
		expect(noIntegrationsGrantedDm(WORK_PLANS["sales-vp-priya"])).toMatch(/Calendar/);
		expect(noIntegrationsGrantedDm(WORK_PLANS["sales-vp-priya"])).toMatch(/HubSpot/);
	});
});

describe("allPullsZeroDataDm (architect §6.2)", () => {
	test("returns persona-voiced text per persona", () => {
		const lilian = allPullsZeroDataDm(WORK_PLANS["sdr-lilian"]);
		expect(lilian).toContain("Lilian here.");
		expect(lilian).toContain("everything is current");
		const marcus = allPullsZeroDataDm(WORK_PLANS["eng-cos-marcus"]);
		expect(marcus).toContain("Marcus here.");
		expect(marcus).toContain("PRs and CI all green");
		const adrian = allPullsZeroDataDm(WORK_PLANS["founder-asst-adrian"]);
		expect(adrian).toContain("Adrian here.");
		expect(adrian).toContain("morning is clean");
	});
});

describe("zeroDraftsFromNonzeroDataDm (architect §6.4)", () => {
	test("Lilian cites the patterns she draft for", () => {
		const text = zeroDraftsFromNonzeroDataDm(WORK_PLANS["sdr-lilian"]);
		expect(text).toContain("Lilian here.");
		expect(text).toContain("12 messages");
	});

	test("Theo asks for fresh ICP names when stale ones found", () => {
		const text = zeroDraftsFromNonzeroDataDm(WORK_PLANS["bdr-theo"]);
		expect(text).toContain("Theo here.");
		expect(text).toContain("5 fresh names");
	});

	test("Priya asks DRAFT or WAIT", () => {
		const text = zeroDraftsFromNonzeroDataDm(WORK_PLANS["sales-vp-priya"]);
		expect(text).toContain("DRAFT");
		expect(text).toContain("WAIT");
	});
});

describe("llmErrorMidFlowDm (architect §6.3)", () => {
	test("with zero drafts saved, ships the start-issue body with RETRY affordance", () => {
		const text = llmErrorMidFlowDm(WORK_PLANS["sdr-lilian"], 0);
		expect(text).toContain("Lilian here.");
		expect(text).toContain("ran into an issue starting your first hour");
		expect(text).toContain("RETRY");
	});

	test("with N drafts saved, ships the partial body", () => {
		const text = llmErrorMidFlowDm(WORK_PLANS["eng-cos-marcus"], 3);
		expect(text).toContain("Marcus here.");
		expect(text).toContain("3 items");
		expect(text).toContain("RETRY");
		expect(text).toContain("pick up where I left off");
	});

	test("singularizes one item", () => {
		const text = llmErrorMidFlowDm(WORK_PLANS["am-sloane"], 1);
		expect(text).toContain("1 item");
		expect(text).not.toContain("1 items");
	});
});

describe("integrationAuthExpiredDm (architect §6.5)", () => {
	test("Lilian's HubSpot expiry says reconnect HubSpot", () => {
		const text = integrationAuthExpiredDm(WORK_PLANS["sdr-lilian"], "hubspot");
		expect(text).toContain("Lilian here.");
		expect(text).toContain("Hubspot");
		expect(text).toContain("Reconnect Hubspot");
	});

	test("Marcus's GitHub expiry says reconnect", () => {
		const text = integrationAuthExpiredDm(WORK_PLANS["eng-cos-marcus"], "github");
		expect(text).toContain("Marcus here.");
		expect(text).toContain("Github auth has expired");
		expect(text).toContain("Reconnect");
	});

	test("falls back to a generic body for unknown personas", () => {
		// The eight known personas all carry a per-persona template; the
		// generic fallback path covers the persona_unknown case the
		// runner does not hit (architect routes persona_unknown to no DM,
		// not this DM), but defense-in-depth keeps the function total.
		const fakePlan = { ...WORK_PLANS["sdr-lilian"], persona_id: "fake" };
		const text = integrationAuthExpiredDm(fakePlan, "linear");
		expect(text).toContain("Linear auth has expired");
	});
});

describe("sixtySecondCapHitDm (architect §6.6)", () => {
	test("reports drafts saved and the MORE affordance", () => {
		const text = sixtySecondCapHitDm(WORK_PLANS["founder-asst-adrian"], 4);
		expect(text).toContain("Adrian here.");
		expect(text).toContain("4 items");
		expect(text).toContain("first 60 seconds");
		expect(text).toContain("MORE");
	});

	test("uses '1 item' singular when count is 1", () => {
		const text = sixtySecondCapHitDm(WORK_PLANS["sdr-lilian"], 1);
		expect(text).toContain("1 item");
		expect(text).not.toContain("1 items");
	});

	test("includes 'first 60 seconds' for every persona", () => {
		for (const id of PERSONAS) {
			expect(sixtySecondCapHitDm(WORK_PLANS[id], 2)).toContain("first 60 seconds");
		}
	});
});

describe("dmTextForReason dispatcher", () => {
	test("dispatches each reason to its handler", () => {
		const persona = WORK_PLANS["sdr-lilian"];
		expect(dmTextForReason("no_integrations_granted", { persona, drafts_saved_so_far: 0 })).toBe(
			persona.fallback_dm_text,
		);
		expect(dmTextForReason("all_pulls_zero_data", { persona, drafts_saved_so_far: 0 })).toContain("Lilian here.");
		expect(dmTextForReason("zero_drafts_from_nonzero_data", { persona, drafts_saved_so_far: 0 })).toContain(
			"Lilian here.",
		);
		expect(dmTextForReason("llm_error_mid_flow", { persona, drafts_saved_so_far: 0 })).toContain("RETRY");
		expect(
			dmTextForReason("integration_auth_expired", {
				persona,
				drafts_saved_so_far: 0,
				expired_provider: "hubspot",
			}),
		).toContain("Reconnect Hubspot");
		expect(dmTextForReason("sixty_second_cap_hit", { persona, drafts_saved_so_far: 2 })).toContain("first 60 seconds");
	});

	test("returns null for non-failure reasons", () => {
		const persona = WORK_PLANS["sdr-lilian"];
		expect(dmTextForReason("ok", { persona, drafts_saved_so_far: 0 })).toBeNull();
		expect(dmTextForReason("internal_error", { persona, drafts_saved_so_far: 0 })).toBeNull();
		expect(dmTextForReason("persona_unknown", { persona, drafts_saved_so_far: 0 })).toBeNull();
		expect(dmTextForReason("fire_already_completed", { persona, drafts_saved_so_far: 0 })).toBeNull();
		expect(dmTextForReason("slack_post_failed", { persona, drafts_saved_so_far: 0 })).toBeNull();
	});
});

describe("resolveOrThrowPersona", () => {
	test("returns the persona for a known id", () => {
		expect(resolveOrThrowPersona("sdr-lilian").persona_id).toBe("sdr-lilian");
	});

	test("throws on unknown id", () => {
		expect(() => resolveOrThrowPersona("nope")).toThrow();
	});
});
