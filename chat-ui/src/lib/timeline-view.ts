import { runTimelineSummaryToView } from "./chat-activity";
import type { SessionDetail } from "./client";
import type { RunTimelineView } from "./chat-types";

export function buildTimelineViewMap(detail: SessionDetail): Map<string, RunTimelineView> {
	const map = new Map<string, RunTimelineView>();
	const resumeWillOwnActiveRun =
		detail.stream_state?.writer_active === true || detail.stream_state?.has_incomplete_tail === true;
	for (const timeline of detail.run_timelines ?? []) {
		if (resumeWillOwnActiveRun && timeline.assistant_message_id === null && timeline.summary.status === "working") {
			continue;
		}
		const key = timeline.assistant_message_id ?? timeline.user_message_id;
		map.set(key, runTimelineSummaryToView(timeline.summary));
	}
	return map;
}
