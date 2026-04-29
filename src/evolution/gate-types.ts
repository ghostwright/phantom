// Phase 1 gate types. Kept in a separate module so the pure types can be
// imported by queue.ts, cadence.ts, and the test suite without pulling in
// the prompt strings, the Zod schema, or the runtime dependency.

export type GateSource = "haiku" | "failsafe";

/**
 * Decision returned by `decideGate`. `source` is either `haiku` (the gate
 * subprocess returned a valid JSON decision) or `failsafe` (the gate errored
 * and TypeScript defaulted fire=true to bias toward not losing learning
 * signal on transient failures).
 */
export type GateDecision = {
	fire: boolean;
	source: GateSource;
	reason: string;
	haiku_cost_usd: number;
};
