// Persona work-plan scaffold: the type contract slice 15 plugs into.
//
// Slice 15 (First Hour of Work) ships the engine that runs the moment a
// tenant provisions: PULL -> IDENTIFY -> DRAFT -> APPROVE. This file is
// the type the engine consumes, plus a stub builder that returns the
// shape with empty data_pulls / drafts / open_questions for each
// persona. Slice 15 fills the actual content; this PR locks the
// contract so slice 15 plugs in without a shape change.
//
// Why a stub today and not the full plan: slice 15 owns the data-pull
// queries, the draft templates, and the clarifying questions. The
// architect doc spells those out per persona in sections 5 and 2.x; the
// content lands when slice 15's engine consumes it. Shipping the stub
// here means slice 15 can land as a content-only PR rather than a
// type + content PR, which keeps the slice-16-to-15 transition clean.

import { getPersonaById } from "./catalog.ts";

export interface PersonaWorkPlanDataPull {
	source: string;
	query: string;
}

export interface PersonaWorkPlanDraft {
	kind: string;
	trigger: string;
	template: string;
}

export interface PersonaWorkPlan {
	persona_id: string;
	data_pulls: PersonaWorkPlanDataPull[];
	drafts: PersonaWorkPlanDraft[];
	open_questions: string[];
}

// getPersonaWorkPlan returns the empty work-plan shape for a known
// persona. Returns null when the persona id is unknown so the caller
// can degrade to the persona-less default behavior. Slice 15 swaps the
// empty arrays for the actual queries, drafts, and questions; the
// shape stays the same.
export function getPersonaWorkPlan(personaId: string | undefined): PersonaWorkPlan | null {
	const entry = getPersonaById(personaId);
	if (!entry) return null;
	return {
		persona_id: entry.character_id,
		data_pulls: [],
		drafts: [],
		open_questions: [],
	};
}
