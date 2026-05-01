import { describe, expect, it } from "vitest";
import type { SessionDetail } from "../../lib/client";
import { buildTimelineViewMap } from "../../lib/timeline-view";

function detail(overrides: Partial<SessionDetail> = {}): SessionDetail {
	return {
		id: "session-1",
		title: "Session",
		created_at: "2026-05-01T00:00:00.000Z",
		updated_at: "2026-05-01T00:00:00.000Z",
		last_message_at: "2026-05-01T00:00:00.000Z",
		message_count: 1,
		total_cost_usd: 0,
		pinned: 0,
		status: "active",
		messages: [],
		stream_state: {
			max_seq: 4,
			latest_terminal_seq: 1,
			writer_active: false,
			has_incomplete_tail: false,
		},
		run_timelines: [
			{
				id: "run-1",
				session_id: "session-1",
				user_message_id: "user-1",
				assistant_message_id: null,
				start_seq: 1,
				end_seq: null,
				status: "working",
				started_at: "2026-05-01T00:00:00.000Z",
				completed_at: null,
				current_label: "Using Bash...",
				stop_reason: null,
				duration_ms: null,
				cost_usd: null,
				input_tokens: null,
				output_tokens: null,
				summary: {
					schemaVersion: 1,
					status: "working",
					startSeq: 1,
					endSeq: null,
					startedAt: "2026-05-01T00:00:00.000Z",
					currentLabel: "Using Bash...",
					tools: [],
					subagents: [],
					errors: [],
				},
			},
		],
		...overrides,
	};
}

describe("buildTimelineViewMap", () => {
	it("skips an unassigned working timeline when resume will replay the active run", () => {
		const map = buildTimelineViewMap(
			detail({
				stream_state: {
					max_seq: 4,
					latest_terminal_seq: 1,
					writer_active: true,
					has_incomplete_tail: false,
				},
			}),
		);

		expect(map.has("user-1")).toBe(false);
	});

	it("keeps completed user-attached timelines after reload", () => {
		const base = detail();
		const timeline = base.run_timelines?.[0];
		if (!timeline) throw new Error("missing test timeline");
		const map = buildTimelineViewMap({
			...base,
			run_timelines: [
				{
					...timeline,
					end_seq: 6,
					status: "completed",
					completed_at: "2026-05-01T00:00:03.000Z",
					summary: {
						...timeline.summary,
						status: "completed",
						endSeq: 6,
						completedAt: "2026-05-01T00:00:03.000Z",
					},
				},
			],
		});

		expect(map.get("user-1")?.activity.status).toBe("completed");
	});
});
