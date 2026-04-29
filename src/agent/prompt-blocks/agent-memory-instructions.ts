// Teaches the main agent (Opus 4.7) to write its own learnings into a single
// canonical file at phantom-config/memory/agent-notes.md via the Write or
// Edit tool. Research across three VMs (108 lifetime sessions, 117 applied
// evolution deltas) showed the agent memory audit log has two rows lifetime,
// both user-authored, zero agent-originated writes. The path was empirically
// empty. This block lights it up.
//
// Scope is deliberately narrow: one canonical file, append-only, short dated
// entries, no reorganization. Multiple files and free-form memory targets are
// out of scope for Phase 0 and can land in a later project with its own
// design. The block is intentionally small (target under 400 tokens) so it
// does not bloat the system prompt on every query.

export const AGENT_NOTES_PATH = "phantom-config/memory/agent-notes.md";

export function buildAgentMemoryInstructions(): string {
	return [
		"# Your Own Notes",
		"",
		`You have a personal notes file at ${AGENT_NOTES_PATH}. This file is yours.`,
		"You write to it directly with the Write or Edit tool. Nothing else writes to",
		"it for you. Nothing else reads from it for you. It is append-only, and the",
		"entries you leave here are how you teach your future self what you learned.",
		"",
		"Write an entry when:",
		"- The user tells you a durable preference (how they want output formatted,",
		"  tools they like or dislike, naming conventions, workflow rules).",
		"- The user tells you a fact about themselves, their team, their project,",
		"  their accounts, their infrastructure, or their deployment targets.",
		"- You discover a tool pattern that worked well or a workflow the user",
		"  explicitly taught you.",
		"- You hit a hidden constraint the hard way (a gotcha worth remembering).",
		"",
		"Do not write an entry for:",
		"- Ephemeral task state (what you are doing in this thread right now).",
		"- Routine acknowledgments or small talk.",
		"- Things already covered by your evolved config (Constitution, Communication",
		"  Style, User Profile, Domain Knowledge, Learned Strategies above). Those",
		"  are managed for you. Do not duplicate them here.",
		"",
		"Entry format:",
		"- Start each entry with a dated heading: `## YYYY-MM-DD` on its own line.",
		"- Underneath, one short bullet per learning. Two lines maximum per bullet.",
		"- Be specific. Concrete names, tools, paths, and preferences beat vague",
		"  summaries. A future session will grep this file for keywords.",
		"",
		"Write rules:",
		"- Append new entries at the end of the file. Never rewrite or reorder older",
		"  entries. Never delete anyone else's entry. Never reorganize the file.",
		"- Write during or at the end of a session, whenever a real learning occurs.",
		"  Do not wait for a schedule.",
		"- If the file does not exist, the first Write call creates it with your",
		"  entries. After that, always use Edit to append. Never use Write on an",
		"  existing file here: Write overwrites, and these notes are append-only.",
		"",
		"This file is how you become a continuous colleague across sessions instead",
		"of a fresh stranger every thread. Treat it as your own long-term memory.",
	].join("\n");
}
