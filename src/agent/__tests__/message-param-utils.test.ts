import { describe, expect, test } from "bun:test";
import { extractTextFromMessageParam, wrapMessageContent } from "../message-param-utils.ts";

// The MessageParam type is { role: string; content: string | unknown[] }
// We construct values matching that shape for testing.

describe("extractTextFromMessageParam", () => {
	test("extracts text from string content", () => {
		const msg = { role: "user", content: "Hello world" };
		expect(extractTextFromMessageParam(msg)).toBe("Hello world");
	});

	test("extracts text from array with single text block", () => {
		const msg = {
			role: "user",
			content: [{ type: "text", text: "Hello from array" }],
		};
		expect(extractTextFromMessageParam(msg)).toBe("Hello from array");
	});

	test("joins multiple text blocks with newline", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "First" },
				{ type: "text", text: "Second" },
			],
		};
		expect(extractTextFromMessageParam(msg)).toBe("First\nSecond");
	});

	test("skips non-text blocks", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "image", source: { data: "abc" } },
				{ type: "text", text: "Only text" },
			],
		};
		expect(extractTextFromMessageParam(msg)).toBe("Only text");
	});

	test("returns empty string for non-array non-string content", () => {
		const msg = { role: "user", content: 42 };
		expect(extractTextFromMessageParam(msg as unknown as { role: string; content: string })).toBe("");
	});

	test("returns empty string for empty array", () => {
		const msg = { role: "user", content: [] };
		expect(extractTextFromMessageParam(msg)).toBe("");
	});

	test("skips text blocks with empty text", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "" },
				{ type: "text", text: "Real content" },
			],
		};
		expect(extractTextFromMessageParam(msg)).toBe("Real content");
	});
});

describe("wrapMessageContent", () => {
	const wrapper = (text: string) => `<wrapped>${text}</wrapped>`;

	test("wraps string content directly", () => {
		const msg = { role: "user", content: "Hello" };
		const result = wrapMessageContent(msg, wrapper);
		expect(result.content).toBe("<wrapped>Hello</wrapped>");
	});

	test("wraps the last text block in array content", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "First" },
				{ type: "text", text: "Last" },
			],
		};
		const result = wrapMessageContent(msg, wrapper);
		const blocks = result.content as { type: string; text: string }[];
		expect(blocks[0].text).toBe("First");
		expect(blocks[1].text).toBe("<wrapped>Last</wrapped>");
	});

	test("only wraps the last text block, not earlier ones", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "text", text: "A" },
				{ type: "image", source: { data: "x" } },
				{ type: "text", text: "B" },
				{ type: "text", text: "C" },
			],
		};
		const result = wrapMessageContent(msg, wrapper);
		const blocks = result.content as { type: string; text?: string }[];
		expect(blocks[0].text).toBe("A");
		expect(blocks[2].text).toBe("B");
		expect(blocks[3].text).toBe("<wrapped>C</wrapped>");
	});

	test("handles array with no text blocks", () => {
		const msg = {
			role: "user",
			content: [{ type: "image", source: { data: "x" } }],
		};
		const result = wrapMessageContent(msg, wrapper);
		const blocks = result.content as { type: string }[];
		// No text block to wrap, array stays unchanged
		expect(blocks).toHaveLength(1);
		expect(blocks[0].type).toBe("image");
	});

	test("wraps empty string for non-array non-string content", () => {
		const msg = { role: "user", content: 42 };
		const result = wrapMessageContent(msg as unknown as { role: string; content: string }, wrapper);
		expect(result.content).toBe("<wrapped></wrapped>");
	});

	test("preserves other message properties", () => {
		const msg = { role: "user", content: "Hello", extra: "keep" };
		const result = wrapMessageContent(msg as unknown as { role: string; content: string }, wrapper);
		expect((result as unknown as { role: string }).role).toBe("user");
	});

	test("preserves non-text blocks in their original positions", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "image", source: { data: "img1" } },
				{ type: "text", text: "Caption" },
				{ type: "image", source: { data: "img2" } },
			],
		};
		const result = wrapMessageContent(msg, wrapper);
		const blocks = result.content as { type: string; text?: string; source?: { data: string } }[];
		expect(blocks[0].source?.data).toBe("img1");
		expect(blocks[1].text).toBe("<wrapped>Caption</wrapped>");
		expect(blocks[2].source?.data).toBe("img2");
	});
});
