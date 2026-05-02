// Tests for the persona system-prompt overlay (Slice 16b).
//
// Covers:
//   - Each of the seven personas renders the persona's system_prompt_overlay
//     as a "# Your Voice And Role" section.
//   - The ${ownerName} placeholder is substituted from PHANTOM_OWNER_NAME.
//   - When ownerName is unset, the placeholder falls back to "your founder"
//     so the sentence stays grammatical.
//   - When PHANTOR_PERSONA_ID is unset, empty, whitespace, or unknown, the
//     builder returns the empty string and the assembler drops the slot.
//   - The env reader trims and rejects empty strings.

import { describe, expect, test } from "bun:test";
import { PERSONA_CATALOG, PERSONA_IDS } from "../catalog.ts";
import { buildPersonaSystemPromptOverlay, readPersonaSystemPromptEnv } from "../system-prompt.ts";

describe("buildPersonaSystemPromptOverlay", () => {
	test("renders the persona's system_prompt_overlay as a 'Your Voice And Role' section", () => {
		const overlay = buildPersonaSystemPromptOverlay({
			personaId: "sdr-lilian",
			ownerName: "Cheema",
		});
		expect(overlay).toContain("# Your Voice And Role");
		expect(overlay).toContain("You are Lilian");
		expect(overlay).toContain("the SDR for Cheema");
	});

	test("substitutes ${ownerName} for each of the seven personas", () => {
		for (const id of PERSONA_IDS) {
			const overlay = buildPersonaSystemPromptOverlay({
				personaId: id,
				ownerName: "Cheema",
			});
			const expected = PERSONA_CATALOG[id].system_prompt_overlay.replaceAll("${ownerName}", "Cheema");
			expect(overlay).toContain(expected);
			// The placeholder text must NOT appear in the rendered overlay
			// for any of the seven personas; otherwise the agent would
			// read a literal "${ownerName}" in its system prompt.
			expect(overlay).not.toContain("${ownerName}");
		}
	});

	test("falls back to 'your founder' when ownerName is unset", () => {
		const overlay = buildPersonaSystemPromptOverlay({
			personaId: "founder-asst-adrian",
			ownerName: undefined,
		});
		expect(overlay).toContain("for your founder");
		expect(overlay).not.toContain("${ownerName}");
	});

	test("returns the empty string when personaId is unset", () => {
		const overlay = buildPersonaSystemPromptOverlay({ personaId: undefined, ownerName: "Cheema" });
		expect(overlay).toBe("");
	});

	test("returns the empty string when personaId is unknown", () => {
		const overlay = buildPersonaSystemPromptOverlay({
			personaId: "not-a-real-persona",
			ownerName: "Cheema",
		});
		expect(overlay).toBe("");
	});

	test("returns the empty string when personaId is whitespace-only", () => {
		const overlay = buildPersonaSystemPromptOverlay({ personaId: "   ", ownerName: "Cheema" });
		expect(overlay).toBe("");
	});
});

describe("readPersonaSystemPromptEnv", () => {
	test("reads PHANTOM_PERSONA_ID and PHANTOM_OWNER_NAME from a custom env shape", () => {
		const env = {
			PHANTOM_PERSONA_ID: "eng-cos-marcus",
			PHANTOM_OWNER_NAME: "Cheema",
		} as NodeJS.ProcessEnv;
		const shape = readPersonaSystemPromptEnv(env);
		expect(shape.personaId).toBe("eng-cos-marcus");
		expect(shape.ownerName).toBe("Cheema");
	});

	test("trims whitespace and rejects empty strings as 'unset'", () => {
		const env = {
			PHANTOM_PERSONA_ID: "  am-sloane  ",
			PHANTOM_OWNER_NAME: "  ",
		} as NodeJS.ProcessEnv;
		const shape = readPersonaSystemPromptEnv(env);
		expect(shape.personaId).toBe("am-sloane");
		expect(shape.ownerName).toBeUndefined();
	});

	test("returns both fields as undefined when neither env is set", () => {
		const shape = readPersonaSystemPromptEnv({} as NodeJS.ProcessEnv);
		expect(shape.personaId).toBeUndefined();
		expect(shape.ownerName).toBeUndefined();
	});
});

describe("buildPersonaSystemPromptOverlay end-to-end with each persona", () => {
	for (const id of PERSONA_IDS) {
		test(`${id} renders a non-empty Your Voice And Role section`, () => {
			const overlay = buildPersonaSystemPromptOverlay({
				personaId: id,
				ownerName: "Cheema",
			});
			expect(overlay.length).toBeGreaterThan(50);
			expect(overlay.startsWith("# Your Voice And Role")).toBe(true);
		});
	}
});
