// Tests for the LLM envelope parser. The runner depends on a clean
// JSON envelope from the model's final text; the parser tolerates
// markdown fences and rejects malformed shapes without throwing.

import { describe, expect, test } from "bun:test";
import { parseEnvelope } from "../llm-caller.ts";

describe("parseEnvelope", () => {
	test("parses a clean JSON envelope", () => {
		const text = JSON.stringify({
			pulls_executed: [{ source: "github", query: "search", rows: 12 }],
			drafts: [
				{
					kind: "slack_reply",
					summary: "Reply to Acme",
					body: "Hi Sarah, here is the v3 quote.",
					reference_url: "https://example.com",
					edit_hints: "tighten the ask",
				},
			],
		});
		const out = parseEnvelope(text);
		expect(out.pulls_executed).toHaveLength(1);
		expect(out.pulls_executed[0].source).toBe("github");
		expect(out.saved_drafts).toHaveLength(1);
		expect(out.saved_drafts[0].kind).toBe("slack_reply");
		expect(out.saved_drafts[0].body).toContain("Sarah");
	});

	test("strips a markdown fence around the JSON", () => {
		const json = JSON.stringify({ pulls_executed: [], drafts: [] });
		const text = `\`\`\`json\n${json}\n\`\`\``;
		const out = parseEnvelope(text);
		expect(out.llm_error).toBeUndefined();
	});

	test("returns no_json_envelope on empty text", () => {
		expect(parseEnvelope("").llm_error).toBe("no_json_envelope");
	});

	test("returns envelope_parse_error on broken JSON inside braces", () => {
		expect(parseEnvelope("{unterminated foo}").llm_error).toBe("envelope_parse_error");
	});

	test("returns no_json_envelope when no closing brace is present", () => {
		expect(parseEnvelope("{unterminated").llm_error).toBe("no_json_envelope");
	});

	test("drops drafts with unknown kind", () => {
		const text = JSON.stringify({
			pulls_executed: [],
			drafts: [
				{ kind: "fake_kind", summary: "x", body: "y" },
				{ kind: "slack_reply", summary: "good", body: "actual body" },
			],
		});
		const out = parseEnvelope(text);
		expect(out.saved_drafts).toHaveLength(1);
		expect(out.saved_drafts[0].kind).toBe("slack_reply");
	});

	test("drops drafts without body", () => {
		const text = JSON.stringify({
			pulls_executed: [],
			drafts: [
				{ kind: "slack_reply", summary: "x" },
				{ kind: "slack_reply", summary: "x", body: "" },
			],
		});
		const out = parseEnvelope(text);
		expect(out.saved_drafts).toHaveLength(0);
	});

	test("surfaces expired_provider when present", () => {
		const text = JSON.stringify({
			pulls_executed: [],
			drafts: [],
			expired_provider: "github",
		});
		const out = parseEnvelope(text);
		expect(out.expired_provider).toBe("github");
	});

	test("surfaces llm_error when the model self-reports", () => {
		const text = JSON.stringify({
			pulls_executed: [],
			drafts: [],
			llm_error: "rate_limited",
		});
		const out = parseEnvelope(text);
		expect(out.llm_error).toBe("rate_limited");
	});

	test("extracts JSON when surrounded by leading/trailing prose", () => {
		const text = 'Some thinking here. {"pulls_executed":[],"drafts":[]} done.';
		const out = parseEnvelope(text);
		expect(out.llm_error).toBeUndefined();
	});
});
