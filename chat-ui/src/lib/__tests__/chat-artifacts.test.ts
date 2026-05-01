import { describe, expect, it } from "vitest";
import { extractToolArtifacts, formatArtifactSize } from "../chat-artifacts";
import type { ToolCallState } from "../chat-types";

function tool(overrides: Partial<ToolCallState>): ToolCallState {
	return {
		id: "tool-1",
		messageId: "message-1",
		toolName: "mcp__phantom-web-ui__phantom_create_page",
		state: "result",
		inputJson: "{}",
		isMcp: true,
		...overrides,
	};
}

describe("extractToolArtifacts", () => {
	it("extracts created page artifacts from structured tool output", () => {
		const artifacts = extractToolArtifacts([
			tool({
				input: { title: "Sendoso vs Reachdesk", path: "sendoso-vs-reachdesk.html" },
				output: JSON.stringify({
					created: true,
					path: "sendoso-vs-reachdesk.html",
					url: "http://127.0.0.1:3112/ui/sendoso-vs-reachdesk.html",
					size: 4221,
				}),
			}),
		]);

		expect(artifacts).toEqual([
			{
				id: "page:http://127.0.0.1:3112/ui/sendoso-vs-reachdesk.html",
				type: "page",
				title: "Sendoso vs Reachdesk",
				url: "http://127.0.0.1:3112/ui/sendoso-vs-reachdesk.html",
				path: "sendoso-vs-reachdesk.html",
				sizeBytes: 4221,
				sourceToolName: "phantom_create_page",
			},
		]);
	});

	it("derives a relative page URL from preview input path", () => {
		const artifacts = extractToolArtifacts([
			tool({
				toolName: "phantom_preview_page",
				input: { path: "reports/weekly.html" },
				output: JSON.stringify({ status: 200, title: "Weekly Report" }),
			}),
		]);

		expect(artifacts[0]?.url).toBe("/ui/reports/weekly.html");
		expect(artifacts[0]?.path).toBe("reports/weekly.html");
		expect(artifacts[0]?.title).toBe("Weekly Report");
	});

	it("does not turn magic login links into artifacts", () => {
		const artifacts = extractToolArtifacts([
			tool({
				toolName: "mcp__phantom-web-ui__phantom_generate_login",
				output: JSON.stringify({
					magicLink: "http://127.0.0.1:3112/ui/login?magic=secret",
					expiresIn: "10 minutes",
				}),
			}),
			tool({
				output: JSON.stringify({
					url: "http://127.0.0.1:3112/ui/login?magic=secret",
					path: "login",
				}),
			}),
		]);

		expect(artifacts).toEqual([]);
	});

	it("finds safe page URLs from text output and deduplicates them", () => {
		const output = "Fetched http://example.com first. Created http://localhost:3100/ui/profile.html. You can share it.";
		const artifacts = extractToolArtifacts([tool({ id: "tool-1", output }), tool({ id: "tool-2", output })]);

		expect(artifacts).toHaveLength(1);
		expect(artifacts[0]?.url).toBe("http://localhost:3100/ui/profile.html");
	});

	it("ignores unfinished tools", () => {
		const artifacts = extractToolArtifacts([
			tool({
				state: "running",
				output: JSON.stringify({ url: "http://localhost:3100/ui/profile.html" }),
			}),
		]);

		expect(artifacts).toEqual([]);
	});
});

describe("formatArtifactSize", () => {
	it("formats byte counts compactly", () => {
		expect(formatArtifactSize(undefined)).toBeNull();
		expect(formatArtifactSize(512)).toBe("512 B");
		expect(formatArtifactSize(2048)).toBe("2.0 KB");
		expect(formatArtifactSize(1024 * 1024 * 2.2)).toBe("2.2 MB");
	});
});
