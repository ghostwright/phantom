// Single-source-of-truth picker for the Agent SDK `thinking` option.
//
// The matrix is non-uniform across models:
//   - Opus 4.7 only accepts `{ type: "adaptive" }`. Manual `enabled +
//     budget_tokens` is rejected with a 400.
//   - Haiku 4.5 only accepts `{ type: "enabled", budget_tokens: N }`.
//     Adaptive is rejected with a 400.
//   - Sonnet 4.6 accepts both shapes (manual is deprecated but still
//     functional).
//
// Verified against the live Messages API on 2026-04-29; see the design
// note at local/2026-04-29-thinking-config-design.md (local-only).
//
// Every SDK `query()` callsite spreads `getThinkingConfig(model)` instead
// of hard-coding a single shape, so reflection (Haiku tier), chat (Opus
// tier), judges (Sonnet tier), and the AgentRuntime path all pick the
// correct shape. New models default to adaptive because every model
// Anthropic has shipped since 4.7 only accepts adaptive.

import type { ThinkingConfig } from "@anthropic-ai/claude-agent-sdk";

const ADAPTIVE_PREFIXES: readonly string[] = [
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-mythos",
];

const MANUAL_ONLY_PREFIXES: readonly string[] = [
	"claude-haiku-4",
	"claude-haiku-3",
	"claude-sonnet-3",
	"claude-sonnet-4-5",
	"claude-opus-4-5",
];

const MANUAL_BUDGET_TOKENS = 8192;

export function getThinkingConfig(model: string | undefined | null): ThinkingConfig {
	if (!model) return { type: "adaptive" };
	if (ADAPTIVE_PREFIXES.some((p) => model.startsWith(p))) {
		return { type: "adaptive" };
	}
	if (MANUAL_ONLY_PREFIXES.some((p) => model.startsWith(p))) {
		return { type: "enabled", budgetTokens: MANUAL_BUDGET_TOKENS };
	}
	// Unknown model: prefer adaptive. Every model Anthropic has released
	// since Opus 4.7 only accepts adaptive, so a new variant is far more
	// likely to require adaptive than to require manual mode. If wrong,
	// the API returns a clear 400 error with the required shape.
	return { type: "adaptive" };
}
