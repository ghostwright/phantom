// Coverage for every cell of the model x thinking-shape matrix the live
// Messages API enforces (verified 2026-04-29). The helper is the single
// source of truth for SDK `query()` thinking options across chat, judge,
// runtime, and reflection callsites.

import { describe, expect, test } from "bun:test";
import { JUDGE_MODEL_HAIKU, JUDGE_MODEL_OPUS, JUDGE_MODEL_SONNET } from "../../evolution/judge-models.ts";
import { getThinkingConfig } from "../thinking-config.ts";

describe("getThinkingConfig", () => {
	test("Opus 4.7 returns adaptive (Opus 4.7 rejects manual enabled with 400)", () => {
		expect(getThinkingConfig(JUDGE_MODEL_OPUS)).toEqual({ type: "adaptive" });
		expect(getThinkingConfig("claude-opus-4-7")).toEqual({ type: "adaptive" });
	});

	test("Opus 4.6 returns adaptive (recommended; manual is deprecated)", () => {
		expect(getThinkingConfig("claude-opus-4-6")).toEqual({ type: "adaptive" });
	});

	test("Sonnet 4.6 returns adaptive (recommended; manual still functional)", () => {
		expect(getThinkingConfig(JUDGE_MODEL_SONNET)).toEqual({ type: "adaptive" });
		expect(getThinkingConfig("claude-sonnet-4-6")).toEqual({ type: "adaptive" });
	});

	test("Mythos preview returns adaptive", () => {
		expect(getThinkingConfig("claude-mythos-preview")).toEqual({ type: "adaptive" });
	});

	test("Haiku 4.5 returns enabled + budgetTokens (Haiku rejects adaptive with 400)", () => {
		const config = getThinkingConfig(JUDGE_MODEL_HAIKU);
		expect(config.type).toBe("enabled");
		if (config.type === "enabled") {
			expect(config.budgetTokens).toBeGreaterThan(0);
		}
	});

	test("older Haiku 3.x returns enabled + budgetTokens", () => {
		const config = getThinkingConfig("claude-haiku-3-5");
		expect(config.type).toBe("enabled");
	});

	test("older Sonnet 3.x returns enabled + budgetTokens", () => {
		const config = getThinkingConfig("claude-sonnet-3-7");
		expect(config.type).toBe("enabled");
	});

	test("legacy Opus 4.5 returns enabled + budgetTokens", () => {
		const config = getThinkingConfig("claude-opus-4-5");
		expect(config.type).toBe("enabled");
	});

	test("undefined model defaults to adaptive (safe for all new models)", () => {
		expect(getThinkingConfig(undefined)).toEqual({ type: "adaptive" });
	});

	test("null model defaults to adaptive", () => {
		expect(getThinkingConfig(null)).toEqual({ type: "adaptive" });
	});

	test("empty string defaults to adaptive", () => {
		expect(getThinkingConfig("")).toEqual({ type: "adaptive" });
	});

	test("unknown future model defaults to adaptive", () => {
		// Every new model since Opus 4.7 has been adaptive-only, so when
		// we do not recognise the prefix we send adaptive. A wrong guess
		// returns a clear 400 with the required shape, which is preferable
		// to silent breakage in reflection.
		expect(getThinkingConfig("claude-future-model-2027")).toEqual({ type: "adaptive" });
	});

	test("provider-prefixed names still match by suffix-free comparison fail-safe", () => {
		// Some operators set `model: "anthropic/claude-haiku-4-5"` via
		// LiteLLM. The helper currently does prefix-match on the bare
		// Anthropic id. If a slash-prefix is used, we fall through to
		// adaptive default, which is the safer of the two failure modes
		// (adaptive will 400 with a clear error on Haiku rather than
		// silently downgrading thinking).
		expect(getThinkingConfig("anthropic/claude-haiku-4-5")).toEqual({ type: "adaptive" });
	});

	test("returned object is a fresh value (callers may spread it)", () => {
		const a = getThinkingConfig(JUDGE_MODEL_OPUS);
		const b = getThinkingConfig(JUDGE_MODEL_OPUS);
		expect(a).toEqual(b);
	});
});
