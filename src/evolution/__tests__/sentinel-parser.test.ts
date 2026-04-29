import { describe, expect, test } from "bun:test";
import { parseSentinel } from "../reflection-subprocess.ts";

// The sentinel parser is the permissive JSON extractor that turns the
// agent's final text into a structured SubprocessSentinel. It is the
// bridge between "the agent did something" and "TypeScript can route the
// result". Coverage here is a failure-mode safety net.

describe("parseSentinel", () => {
	test("parses a plain object JSON sentinel", () => {
		expect(parseSentinel('{"status":"ok"}')).toEqual({ status: "ok" });
	});

	test("parses a skip sentinel with reason", () => {
		const r = parseSentinel('{"status":"skip","reason":"nothing to learn"}');
		expect(r?.status).toBe("skip");
		expect(r?.reason).toBe("nothing to learn");
	});

	test("parses an escalate sentinel with target", () => {
		const r = parseSentinel('{"status":"escalate","target":"sonnet","reason":"too hard"}');
		expect(r?.status).toBe("escalate");
		expect(r?.target).toBe("sonnet");
	});

	test("parses a sentinel with a compact per-change action and shrinkage", () => {
		// Compaction is a per-change annotation (action:"compact"), not a
		// top-level status. The status union is ok | skip | escalate.
		const r = parseSentinel(
			'{"status":"ok","changes":[{"file":"user-profile.md","action":"compact","expected_shrinkage":0.5}]}',
		);
		expect(r?.status).toBe("ok");
		expect(r?.changes?.[0].action).toBe("compact");
		expect(r?.changes?.[0].expected_shrinkage).toBe(0.5);
	});

	test("extracts JSON from trailing position after prose", () => {
		const text = 'I did the work as requested.\n\n{"status":"ok","changes":[]}';
		expect(parseSentinel(text)?.status).toBe("ok");
	});

	test("picks the LAST JSON object when multiple are present", () => {
		const text = 'First thought: {"status":"ok"} then actually {"status":"skip","reason":"changed my mind"}';
		expect(parseSentinel(text)?.status).toBe("skip");
	});

	test("returns null on empty input", () => {
		expect(parseSentinel("")).toBeNull();
		expect(parseSentinel("   ")).toBeNull();
	});

	test("returns null on prose with no JSON", () => {
		expect(parseSentinel("Hello world, no JSON here.")).toBeNull();
	});

	test("returns null when JSON is present but lacks a valid status", () => {
		expect(parseSentinel('{"not":"a sentinel"}')).toBeNull();
	});

	test("returns null when JSON is malformed", () => {
		expect(parseSentinel("{status: invalid}")).toBeNull();
	});

	test("handles nested JSON structures in the changes array", () => {
		const text = `{"status":"ok","changes":[{"file":"a.md","action":"edit","summary":"first"},{"file":"b.md","action":"new","summary":"second"}]}`;
		const r = parseSentinel(text);
		expect(r?.status).toBe("ok");
		expect(r?.changes).toHaveLength(2);
	});

	test("handles whitespace-only response", () => {
		expect(parseSentinel("   \n   \t")).toBeNull();
	});

	test("handles an escalate target=opus sentinel", () => {
		const r = parseSentinel('{"status":"escalate","target":"opus","reason":"needs top reasoning"}');
		expect(r?.target).toBe("opus");
	});
});
