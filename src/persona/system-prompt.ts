// Persona system-prompt overlay: the block that injects the persona's
// voice and role into the agent's system prompt.
//
// The architect doc (section 7) wires this as slot 1c in the prompt
// assembler, after the tenant-self-knowledge overlay (slot 1b) and
// before the Environment block. The overlay reads PHANTOM_PERSONA_ID
// from process.env, looks up the persona's system_prompt_overlay
// string, substitutes ${ownerName} from PHANTOM_OWNER_NAME, and emits
// a single "# Your Voice And Role" section.
//
// Degradation: when PHANTOM_PERSONA_ID is unset or unknown, the
// builder returns the empty string and the assembler drops the slot
// entirely. This matches the tenant-self-knowledge overlay's pattern
// (Phase 9): the block is purely additive and never gates on a
// per-tenant identifier.
//
// Slice 16b ships the builder; the assembler wiring lands here too so
// slice 16c (phantomd) is the only remaining hop before the overlay
// is end-to-end. Slice 17 (rich chat) does not touch this file.

import { readPersonaFromEnv } from "./catalog.ts";

export interface PersonaSystemPromptEnv {
	personaId?: string;
	ownerName?: string;
}

// readPersonaSystemPromptEnv reads the two env vars the overlay needs.
// PHANTOM_OWNER_NAME is already read by the tenant-self-knowledge
// overlay, but we re-read it here so the persona overlay stays
// self-contained and testable without coupling to the other block.
export function readPersonaSystemPromptEnv(env: NodeJS.ProcessEnv = process.env): PersonaSystemPromptEnv {
	const personaId = env.PHANTOM_PERSONA_ID?.trim();
	const ownerName = env.PHANTOM_OWNER_NAME?.trim();
	return {
		personaId: personaId && personaId.length > 0 ? personaId : undefined,
		ownerName: ownerName && ownerName.length > 0 ? ownerName : undefined,
	};
}

// buildPersonaSystemPromptOverlay builds the "# Your Voice And Role"
// section text. Returns the empty string when the persona is unset,
// unknown, or the overlay text is empty after substitution. The
// assembler treats the empty string as "drop this slot".
//
// The owner-name substitution accepts the literal string "${ownerName}"
// in the catalog's system_prompt_overlay field; when ownerName is
// known, the placeholder is replaced; when ownerName is unset, the
// fallback "your founder" keeps the sentence grammatical.
export function buildPersonaSystemPromptOverlay(env: PersonaSystemPromptEnv = readPersonaSystemPromptEnv()): string {
	const persona = readPersonaFromEnv({
		PHANTOM_PERSONA_ID: env.personaId ?? "",
	} as NodeJS.ProcessEnv);
	if (!persona) return "";
	const ownerName = env.ownerName && env.ownerName.length > 0 ? env.ownerName : "your founder";
	const body = persona.system_prompt_overlay.replaceAll("${ownerName}", ownerName);
	if (!body || body.trim().length === 0) return "";
	return `# Your Voice And Role\n\n${body}`;
}
