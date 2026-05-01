import { describe, expect, test } from "bun:test";
import { createMurphContextTransform } from "../murph-context.ts";

describe("createMurphContextTransform", () => {
	test("injects Phantom context as a Pi-compatible user message before the latest user message", async () => {
		const transform = createMurphContextTransform("User-visible page: http://127.0.0.1:3100/ui/profile.html");
		expect(transform).toBeDefined();

		const userMessage = { role: "user", content: [{ type: "text", text: "Give me the link." }] };
		const output = await transform?.([{ role: "assistant", content: [] }, userMessage]);

		expect(output).toHaveLength(3);
		expect(record(output?.[1])?.role).toBe("user");
		expect(textContent(output?.[1])).toContain("<phantom_chat_context>");
		expect(textContent(output?.[1])).toContain("http://127.0.0.1:3100/ui/profile.html");
		expect(output?.[2]).toBe(userMessage);
	});

	test("replaces stale Phantom context messages instead of accumulating them", async () => {
		const transform = createMurphContextTransform("Fresh context");
		const staleContext = {
			role: "user",
			content: [{ type: "text", text: "<phantom_chat_context>\nStale context\n</phantom_chat_context>" }],
			timestamp: 1,
		};

		const output =
			(await transform?.([{ role: "assistant", content: [] }, staleContext, { role: "toolResult", content: [] }])) ??
			[];

		const phantomContexts = output.filter((message) => textContent(message).includes("<phantom_chat_context>"));
		expect(phantomContexts).toHaveLength(1);
		expect(textContent(phantomContexts[0])).toContain("Fresh context");
		expect(output).not.toContain(staleContext);
	});

	test("rebuilds context from a provider on each transform invocation", async () => {
		let calls = 0;
		const transform = createMurphContextTransform(() => {
			calls += 1;
			return `Fresh context ${calls}`;
		});
		expect(transform).toBeDefined();

		const first = await transform?.([{ role: "user", content: "first" }]);
		const second = await transform?.(first ?? []);

		expect(calls).toBe(2);
		expect(textContent(first?.[0])).toContain("Fresh context 1");
		const contexts = (second ?? []).filter((message) => textContent(message).includes("<phantom_chat_context>"));
		expect(contexts).toHaveLength(1);
		expect(textContent(contexts[0])).toContain("Fresh context 2");
		expect(textContent(second?.[0])).not.toContain("Fresh context 1");
	});

	test("removes stale context when the provider returns empty context", async () => {
		const staleContext = {
			role: "user",
			content: [{ type: "text", text: "<phantom_chat_context>\nStale context\n</phantom_chat_context>" }],
			timestamp: 1,
		};
		const transform = createMurphContextTransform(() => "   ");

		const output = (await transform?.([staleContext, { role: "user", content: "next" }])) ?? [];

		expect(output).toHaveLength(1);
		expect(textContent(output[0])).toBe("next");
		expect(record(output[0])?.role).toBe("user");
	});

	test("returns undefined for empty context", () => {
		expect(createMurphContextTransform("   ")).toBeUndefined();
		expect(createMurphContextTransform(undefined)).toBeUndefined();
	});
});

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function textContent(value: unknown): string {
	const content = record(value)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			const block = record(item);
			return block?.type === "text" && typeof block.text === "string" ? block.text : "";
		})
		.join("\n");
}
