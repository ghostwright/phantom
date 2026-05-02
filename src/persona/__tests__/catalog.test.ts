// Tests for the persona catalog (Slice 16b). Covers:
//   - Completeness: all seven character_ids present, in the locked order.
//   - Field shape: every required field is non-empty for every persona.
//   - Voice contract: no em dashes, no en dashes, no emojis, no
//     marketing voice in any user-facing string field.
//   - Cross-repo invariant placeholder: the seven character_id strings
//     are pinned in this test so any drift versus the architect doc
//     surfaces here even before the cross-repo verifier ships.
//   - Lookup: getPersonaById returns the entry for known ids and
//     undefined for unknown / empty / undefined inputs.
//   - Env reader: readPersonaFromEnv resolves PHANTOM_PERSONA_ID
//     (including whitespace-padded values) and returns undefined for
//     unset / empty / unknown values.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	PERSONA_CATALOG,
	PERSONA_IDS,
	type PersonaCatalogEntry,
	type PersonaId,
	getPersonaById,
	readPersonaFromEnv,
} from "../catalog.ts";

const ORIGINAL_PERSONA_ID = process.env.PHANTOM_PERSONA_ID;

beforeEach(() => {
	process.env.PHANTOM_PERSONA_ID = undefined;
});

afterEach(() => {
	if (ORIGINAL_PERSONA_ID === undefined) {
		process.env.PHANTOM_PERSONA_ID = undefined;
	} else {
		process.env.PHANTOM_PERSONA_ID = ORIGINAL_PERSONA_ID;
	}
});

// The seven character_ids are the cross-repo locked fixture (architect
// doc section 4.1). Any change here MUST land in lockstep with the
// matching change in phantomd, phantom-control, and ghostwright-site;
// the verifier ships in slice 16d. Pinning the list inline keeps the
// drift visible in code review.
const EXPECTED_CHARACTER_IDS: readonly PersonaId[] = [
	"sdr-lilian",
	"eng-cos-marcus",
	"am-sloane",
	"bdr-theo",
	"sales-vp-priya",
	"gtm-eng-ryan",
	"founder-asst-adrian",
];

const REQUIRED_STRING_FIELDS: ReadonlyArray<keyof PersonaCatalogEntry> = [
	"character_id",
	"display_name",
	"subtitle",
	"tagline",
	"default_model",
	"intro_role_phrase",
	"intro_first_commitment",
	"intro_open_offer",
	"system_prompt_overlay",
	"day1_work_description",
];

describe("PERSONA_CATALOG completeness", () => {
	test("contains exactly the seven character_ids in the locked order", () => {
		expect(PERSONA_IDS).toEqual(EXPECTED_CHARACTER_IDS);
		expect(Object.keys(PERSONA_CATALOG).sort()).toEqual([...EXPECTED_CHARACTER_IDS].sort());
	});

	test("every persona has a non-empty value for every required string field", () => {
		for (const id of PERSONA_IDS) {
			const entry = PERSONA_CATALOG[id];
			for (const field of REQUIRED_STRING_FIELDS) {
				const value = entry[field];
				expect(typeof value).toBe("string");
				expect((value as string).trim().length).toBeGreaterThan(0);
			}
		}
	});

	test("character_id field on each entry matches the catalog key", () => {
		// Defense against a copy-paste typo where two entries share the
		// same character_id but live under different keys.
		for (const id of PERSONA_IDS) {
			expect(PERSONA_CATALOG[id].character_id).toBe(id);
		}
	});

	test("default_tools is a non-empty list of strings", () => {
		for (const id of PERSONA_IDS) {
			const tools = PERSONA_CATALOG[id].default_tools;
			expect(Array.isArray(tools)).toBe(true);
			expect(tools.length).toBeGreaterThan(0);
			for (const tool of tools) {
				expect(typeof tool).toBe("string");
				expect(tool.length).toBeGreaterThan(0);
			}
		}
	});

	test("day1_data_pulls is a non-empty list of {source, query} entries", () => {
		for (const id of PERSONA_IDS) {
			const pulls = PERSONA_CATALOG[id].day1_data_pulls;
			expect(Array.isArray(pulls)).toBe(true);
			expect(pulls.length).toBeGreaterThan(0);
			for (const pull of pulls) {
				expect(typeof pull.source).toBe("string");
				expect(pull.source.length).toBeGreaterThan(0);
				expect(typeof pull.query).toBe("string");
				expect(pull.query.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("PERSONA_CATALOG voice contract", () => {
	const userFacingFields: ReadonlyArray<keyof PersonaCatalogEntry> = [
		"display_name",
		"subtitle",
		"tagline",
		"intro_role_phrase",
		"intro_first_commitment",
		"intro_open_offer",
		"system_prompt_overlay",
		"day1_work_description",
	];

	test("no em dash in any user-facing field", () => {
		for (const id of PERSONA_IDS) {
			for (const field of userFacingFields) {
				const value = PERSONA_CATALOG[id][field] as string;
				expect(value).not.toContain("—");
			}
		}
	});

	test("no en dash in any user-facing field", () => {
		for (const id of PERSONA_IDS) {
			for (const field of userFacingFields) {
				const value = PERSONA_CATALOG[id][field] as string;
				expect(value).not.toContain("–");
			}
		}
	});

	test("no emoji in any user-facing field", () => {
		// Spot-check a few categories: marketing sparkles, emoji faces,
		// rocket-launch marketing emoji. A full unicode-range scan is
		// brittle; the curated list catches the patterns we have seen
		// drift in past PRs.
		const banned = ["✨", "\u{1F44B}", "\u{1F680}", "\u{1F389}", "\u{1F525}", "\u{2728}"];
		for (const id of PERSONA_IDS) {
			for (const field of userFacingFields) {
				const value = PERSONA_CATALOG[id][field] as string;
				for (const symbol of banned) {
					expect(value).not.toContain(symbol);
				}
			}
		}
	});

	test("no marketing voice in any user-facing field", () => {
		const bannedPhrases = [
			"blazing fast",
			"industry-leading",
			"Welcome to the future",
			"Maximize",
			"Unleash",
			"Next Level",
		];
		for (const id of PERSONA_IDS) {
			for (const field of userFacingFields) {
				const value = PERSONA_CATALOG[id][field] as string;
				for (const phrase of bannedPhrases) {
					expect(value).not.toContain(phrase);
				}
			}
		}
	});
});

describe("PERSONA_CATALOG architect-doc taglines and role phrases", () => {
	// Pin the verbatim taglines + role phrases against the architect doc.
	// These lines are the cross-repo locked fixture; any change here
	// MUST land in the architect doc and the four mirrors in lockstep.
	// We compare with toEqual against an object literal so the catalog's
	// narrow `as const` literal types do not collide with the test's
	// widened string fields under bun's typed expect overloads.
	const expectedTagline: Record<PersonaId, string> = {
		"sdr-lilian": "Books your meetings. Drafts your outbound. Never lets a lead go cold.",
		"eng-cos-marcus": "Triages your PRs. Drafts your standup. Catches what is on fire before you do.",
		"am-sloane": "Reads every customer thread. Catches churn signals early. Drafts the saves.",
		"bdr-theo": "Researches every prospect. Personalizes every email. Sends only what fits.",
		"sales-vp-priya": "Watches the pipeline. Flags slipping deals. Drafts the board update.",
		"gtm-eng-ryan": "Ships landing pages. Wires integrations. Catches signup drops in real time.",
		"founder-asst-adrian": "Reads every channel. Drafts every reply. Tells you what actually needs you.",
	};
	const expectedRole: Record<PersonaId, string> = {
		"sdr-lilian": "your SDR",
		"eng-cos-marcus": "your engineering chief of staff",
		"am-sloane": "your account manager",
		"bdr-theo": "your BDR",
		"sales-vp-priya": "your sales leader",
		"gtm-eng-ryan": "your GTM engineer",
		"founder-asst-adrian": "your founder's assistant",
	};
	const expectedDisplay: Record<PersonaId, string> = {
		"sdr-lilian": "Lilian",
		"eng-cos-marcus": "Marcus",
		"am-sloane": "Sloane",
		"bdr-theo": "Theo",
		"sales-vp-priya": "Priya",
		"gtm-eng-ryan": "Ryan",
		"founder-asst-adrian": "Adrian",
	};

	for (const id of EXPECTED_CHARACTER_IDS) {
		test(`${id} matches architect-doc tagline + role + display name`, () => {
			const entry = PERSONA_CATALOG[id];
			// Cast to string so bun's typed expect overload widens the
			// comparison against the catalog's narrow `as const` literal.
			expect(entry.display_name as string).toEqual(expectedDisplay[id]);
			expect(entry.subtitle as string).toEqual(expectedRole[id]);
			expect(entry.tagline as string).toEqual(expectedTagline[id]);
			expect(entry.intro_role_phrase as string).toEqual(expectedRole[id]);
		});
	}
});

describe("getPersonaById", () => {
	test("returns the entry for each of the seven known ids", () => {
		for (const id of PERSONA_IDS) {
			const entry = getPersonaById(id);
			expect(entry).toBeDefined();
			expect(entry?.character_id).toBe(id);
		}
	});

	test("returns undefined for an unknown id", () => {
		expect(getPersonaById("not-a-real-persona")).toBeUndefined();
	});

	test("returns undefined for the empty string", () => {
		expect(getPersonaById("")).toBeUndefined();
	});

	test("returns undefined for undefined input", () => {
		expect(getPersonaById(undefined)).toBeUndefined();
	});
});

describe("readPersonaFromEnv", () => {
	test("returns the persona when PHANTOM_PERSONA_ID matches a known id", () => {
		process.env.PHANTOM_PERSONA_ID = "sdr-lilian";
		const persona = readPersonaFromEnv();
		expect(persona?.character_id).toBe("sdr-lilian");
	});

	test("trims whitespace before lookup", () => {
		process.env.PHANTOM_PERSONA_ID = "  eng-cos-marcus  ";
		const persona = readPersonaFromEnv();
		expect(persona?.character_id).toBe("eng-cos-marcus");
	});

	test("returns undefined when PHANTOM_PERSONA_ID is unset", () => {
		expect(readPersonaFromEnv()).toBeUndefined();
	});

	test("returns undefined when PHANTOM_PERSONA_ID is the empty string", () => {
		process.env.PHANTOM_PERSONA_ID = "";
		expect(readPersonaFromEnv()).toBeUndefined();
	});

	test("returns undefined when PHANTOM_PERSONA_ID is whitespace only", () => {
		process.env.PHANTOM_PERSONA_ID = "   ";
		expect(readPersonaFromEnv()).toBeUndefined();
	});

	test("returns undefined when PHANTOM_PERSONA_ID is unknown (defends against typos and 16d validator drift)", () => {
		process.env.PHANTOM_PERSONA_ID = "sdr-typo";
		expect(readPersonaFromEnv()).toBeUndefined();
	});
});
