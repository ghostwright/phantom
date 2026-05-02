// Tests for the persona work-plan scaffold (Slice 16b).
//
// The work-plan is a stub today: empty data_pulls, empty drafts, empty
// open_questions. Slice 15 fills the actual content. The contract these
// tests pin is the SHAPE: getPersonaWorkPlan returns the correct
// per-persona shape for each known id, and null for unknown / unset.
// When slice 15 lands, the empty-array assertions flip to non-empty;
// the rest of these tests stay.

import { describe, expect, test } from "bun:test";
import { PERSONA_IDS } from "../catalog.ts";
import { getPersonaWorkPlan } from "../work-plan.ts";

describe("getPersonaWorkPlan", () => {
	test("returns the empty-stub shape for each of the seven personas", () => {
		for (const id of PERSONA_IDS) {
			const plan = getPersonaWorkPlan(id);
			expect(plan).not.toBeNull();
			if (!plan) throw new Error("plan should be defined");
			expect(plan.persona_id).toBe(id);
			expect(plan.data_pulls).toEqual([]);
			expect(plan.drafts).toEqual([]);
			expect(plan.open_questions).toEqual([]);
		}
	});

	test("returns null for an unknown persona id", () => {
		expect(getPersonaWorkPlan("not-a-real-persona")).toBeNull();
	});

	test("returns null for undefined input", () => {
		expect(getPersonaWorkPlan(undefined)).toBeNull();
	});

	test("returns null for the empty string", () => {
		expect(getPersonaWorkPlan("")).toBeNull();
	});

	test("the returned shape is mutable so slice 15 can fill it without copying", () => {
		// The stub shape uses plain mutable arrays, not readonly arrays,
		// so slice 15's engine can populate the plan in place. This test
		// confirms the contract.
		const plan = getPersonaWorkPlan("sdr-lilian");
		if (!plan) throw new Error("plan should be defined");
		plan.data_pulls.push({ source: "calendar", query: "test" });
		expect(plan.data_pulls.length).toBe(1);
	});
});
