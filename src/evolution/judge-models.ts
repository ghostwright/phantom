// Shared model identifiers for the evolution subsystem.
//
// Phase 3 migrated these constants out of the now-deleted `judges/types.ts`
// so the reflection subprocess and the Phase 1 conditional firing gate can
// import them without depending on the judges directory. Keeping the names
// verbatim (`JUDGE_MODEL_*`) preserves backwards compatibility for the gate
// call site and keeps `git blame` meaningful across the rewrite.
//
// The literal IDs live in exactly one place. Updates should ship as a single
// edit here with a follow-up smoke test on one VM before the fleet rollout.

export const JUDGE_MODEL_HAIKU = "claude-haiku-4-5";
export const JUDGE_MODEL_SONNET = "claude-sonnet-4-6";
export const JUDGE_MODEL_OPUS = "claude-opus-4-7";
