// Pin tests for the system-prompt scaffold (architect §1.4). Drift in
// the scaffold structure is a code change; the test assertions catch
// any unintended edit. The substitutions are the variables; the
// surrounding skeleton is byte-stable.

import { describe, expect, test } from "bun:test";
import { buildScaffoldPrompt, resolvePersonaSubtitle } from "../scaffold-prompt.ts";
import { PERSONA_WORK_PLAN_IDS, WORK_PLANS } from "../work-plans.ts";

describe("buildScaffoldPrompt", () => {
	test("renders the 4-step structure verbatim", () => {
		const prompt = buildScaffoldPrompt({
			persona: WORK_PLANS["sdr-lilian"],
			owner_name: "Cheema",
			owner_user_id: "U999",
			available_integrations: ["slack", "github"],
			persona_subtitle: "your SDR",
		});
		expect(prompt).toContain("STEP 1: PULL");
		expect(prompt).toContain("STEP 2: IDENTIFY");
		expect(prompt).toContain("STEP 3: DRAFT");
		expect(prompt).toContain("STEP 4: DM");
		expect(prompt).toContain("CARDINAL RULES:");
		expect(prompt).toContain("Output the JSON envelope as your FINAL message");
	});

	test("substitutes the persona's intro_line, owner name, and integrations", () => {
		const prompt = buildScaffoldPrompt({
			persona: WORK_PLANS["sdr-lilian"],
			owner_name: "Cheema",
			owner_user_id: "U999",
			available_integrations: ["slack", "github"],
			persona_subtitle: "your SDR",
		});
		expect(prompt).toContain("You are Lilian here, your SDR for Cheema.");
		expect(prompt).toContain("integrations: slack, github");
		expect(prompt).toContain("Send the\nDM to U999");
	});

	test("renders 'none' when no integrations are available", () => {
		const prompt = buildScaffoldPrompt({
			persona: WORK_PLANS["bdr-theo"],
			owner_name: "Owner",
			owner_user_id: "U",
			available_integrations: [],
			persona_subtitle: "your BDR",
		});
		expect(prompt).toContain("integrations: none");
	});

	test("includes the persona's footer_line in STEP 4", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const prompt = buildScaffoldPrompt({
				persona: WORK_PLANS[id],
				owner_name: "X",
				owner_user_id: "U",
				available_integrations: ["slack"],
				persona_subtitle: "you",
			});
			expect(prompt).toContain(WORK_PLANS[id].footer_line);
		}
	});

	test("includes the persona's signal_patterns under STEP 2", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const plan = WORK_PLANS[id];
			const prompt = buildScaffoldPrompt({
				persona: plan,
				owner_name: "X",
				owner_user_id: "U",
				available_integrations: ["slack"],
				persona_subtitle: "you",
			});
			for (const pattern of plan.signal_patterns) {
				expect(prompt).toContain(pattern);
			}
		}
	});

	test("includes the persona's max_drafts as a hard cap reference", () => {
		const prompt = buildScaffoldPrompt({
			persona: WORK_PLANS["eng-cos-marcus"],
			owner_name: "X",
			owner_user_id: "U",
			available_integrations: ["github"],
			persona_subtitle: "your engineering chief of staff",
		});
		expect(prompt).toContain("Cap drafts at\n8");
	});

	test("includes every default_pull source in STEP 1", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const plan = WORK_PLANS[id];
			const prompt = buildScaffoldPrompt({
				persona: plan,
				owner_name: "X",
				owner_user_id: "U",
				available_integrations: ["slack"],
				persona_subtitle: "you",
			});
			for (const pull of plan.default_pulls) {
				expect(prompt).toContain(`source=${pull.source}`);
			}
		}
	});

	test("contains no em dashes in any rendered output", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const prompt = buildScaffoldPrompt({
				persona: WORK_PLANS[id],
				owner_name: "X",
				owner_user_id: "U",
				available_integrations: ["slack"],
				persona_subtitle: "you",
			});
			expect(prompt).not.toMatch(/—/);
		}
	});
});

describe("resolvePersonaSubtitle", () => {
	test("returns each persona's display subtitle", () => {
		expect(resolvePersonaSubtitle("sdr-lilian")).toBe("your SDR");
		expect(resolvePersonaSubtitle("eng-cos-marcus")).toBe("your engineering chief of staff");
		expect(resolvePersonaSubtitle("am-sloane")).toBe("your account manager");
		expect(resolvePersonaSubtitle("bdr-theo")).toBe("your BDR");
		expect(resolvePersonaSubtitle("sales-vp-priya")).toBe("your sales leader");
		expect(resolvePersonaSubtitle("gtm-eng-ryan")).toBe("your GTM engineer");
		expect(resolvePersonaSubtitle("founder-asst-adrian")).toBe("your founder's assistant");
	});

	test("returns a generic fallback for unknown ids", () => {
		expect(resolvePersonaSubtitle("nope")).toBe("your co-worker");
	});
});
