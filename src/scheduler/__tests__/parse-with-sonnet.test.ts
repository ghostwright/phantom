import { describe, expect, mock, test } from "bun:test";
import type { JudgeQueryOptions, JudgeQueryResult } from "../../agent/judge-query.ts";
import type { AgentRuntime } from "../../agent/runtime.ts";
import { parseJobDescription } from "../parse-with-sonnet.ts";

type AnyData = Record<string, unknown>;

function makeRuntime(handler: (opts: JudgeQueryOptions<AnyData>) => Promise<JudgeQueryResult<AnyData>>): {
	runtime: AgentRuntime;
	judgeQuery: ReturnType<typeof mock>;
} {
	const judgeQuery = mock(handler);
	return { runtime: { judgeQuery } as unknown as AgentRuntime, judgeQuery };
}

function hnResult(): JudgeQueryResult<AnyData> {
	return {
		verdict: "pass",
		confidence: 1,
		reasoning: "",
		data: {
			name: "hn-digest",
			description: "Top Hacker News stories every 6 hours",
			task: "Fetch the top 10 Hacker News stories and post a brief summary to Slack.",
			schedule: { kind: "every", intervalMs: 21_600_000 },
			delivery: { channel: "slack", target: "owner" },
		},
		model: "claude-sonnet-4-6",
		inputTokens: 100,
		outputTokens: 50,
		costUsd: 0.01,
		durationMs: 500,
	};
}

describe("parseJobDescription", () => {
	test("returns 422 when runtime is not available", async () => {
		const result = await parseJobDescription("anything", { runtime: null });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(422);
	});

	test("happy path: runtime returns a valid proposal", async () => {
		const { runtime } = makeRuntime(async () => hnResult());
		const result = await parseJobDescription("Pull top HN stories every 6 hours and post a summary to my Slack DM", {
			runtime,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(result.proposal.name).toBe("hn-digest");
		expect(result.proposal.schedule).toEqual({ kind: "every", intervalMs: 21_600_000 });
	});

	test("requests sonnet model and the judge system prompt", async () => {
		const { runtime, judgeQuery } = makeRuntime(async () => hnResult());
		await parseJobDescription("schedule anything", { runtime });
		expect(judgeQuery).toHaveBeenCalledTimes(1);
		const opts = judgeQuery.mock.calls[0][0] as JudgeQueryOptions<AnyData>;
		expect(opts.model).toBe("claude-sonnet-4-6");
		expect(opts.omitPreset).toBe(true);
		expect(typeof opts.systemPrompt).toBe("string");
		expect(opts.systemPrompt).toContain("scheduled job");
	});

	test("422 when the proposal fails the canonical v3 schema", async () => {
		const { runtime } = makeRuntime(async () => ({
			...hnResult(),
			data: { name: "", task: "", schedule: { kind: "unknown" } } as AnyData,
		}));
		const result = await parseJobDescription("vague", { runtime });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(422);
	});

	test("422 when judgeQuery throws", async () => {
		const { runtime } = makeRuntime(async () => {
			throw new Error("subprocess sigkilled");
		});
		const result = await parseJobDescription("anything", { runtime });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("expected failure");
		expect(result.status).toBe(422);
	});

	test("cron schedules round-trip through the schema", async () => {
		const { runtime } = makeRuntime(async () => ({
			...hnResult(),
			data: {
				name: "daily-standup",
				task: "Summarize overnight activity and list three priorities.",
				schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/Los_Angeles" },
				delivery: { channel: "slack", target: "owner" },
			},
		}));
		const result = await parseJobDescription("9am weekdays standup", { runtime });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(result.proposal.schedule).toEqual({ kind: "cron", expr: "0 9 * * 1-5", tz: "America/Los_Angeles" });
	});

	test("at schedules accept ISO with offset", async () => {
		const { runtime } = makeRuntime(async () => ({
			...hnResult(),
			data: {
				name: "one-time-health",
				task: "Verify the deploy succeeded.",
				schedule: { kind: "at", at: "2026-04-18T15:00:00-07:00" },
				delivery: { channel: "slack", target: "owner" },
			},
		}));
		const result = await parseJobDescription("check at 3pm tomorrow", { runtime });
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("expected success");
		expect(result.proposal.schedule).toEqual({ kind: "at", at: "2026-04-18T15:00:00-07:00" });
	});
});
