import { describe, expect, it } from "vitest";
import { runTimelineSummaryToView } from "../chat-activity";
import type { DurableRunTimelineSummary } from "../chat-types";

describe("runTimelineSummaryToView", () => {
	it("preserves durable artifacts for reloaded timelines", () => {
		const summary: DurableRunTimelineSummary = {
			schemaVersion: 1,
			status: "completed",
			startSeq: 1,
			endSeq: 6,
			startedAt: "2026-05-01T00:00:00.000Z",
			completedAt: "2026-05-01T00:00:03.000Z",
			currentLabel: "Completed.",
			artifacts: [
				{
					id: "page:/ui/reports/weekly.html",
					type: "page",
					title: "Weekly Report",
					url: "/ui/reports/weekly.html",
					path: "reports/weekly.html",
					sizeBytes: 8842,
					sourceToolName: "phantom_create_page",
				},
			],
			tools: [
				{
					id: "tool-page",
					name: "phantom_create_page",
					state: "result",
					isMcp: true,
					mcpServer: "phantom-web-ui",
					safeOutputSummary: "Tool produced output.",
				},
			],
			subagents: [],
			errors: [],
		};

		const view = runTimelineSummaryToView(summary);

		expect(view.artifacts).toEqual(summary.artifacts);
		expect(view.toolCalls[0]?.output).toBe("Tool produced output.");
	});
});
