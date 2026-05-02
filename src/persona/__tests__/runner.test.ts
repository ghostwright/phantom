// Integration tests for runFirstHourOfWorkOnFirstboot. Each test
// drives the runner end-to-end with stubbed deps (LLM, slack sender,
// draft sink, ledger sink, audit emitter) and asserts the wire shape
// + reason code + audit trail + persistence.
//
// Coverage:
//   - Happy path: drafts persisted, DM sent, 5 audit events fired in
//     order (start, pulls, drafts, dm, finish).
//   - no_integrations_granted: zero overlap with persona's required
//     integrations, fallback DM sent, no LLM call.
//   - all_pulls_zero_data: pulls succeed with 0 rows, fallback DM.
//   - llm_error_mid_flow: LLM threw, partial drafts persist, degraded
//     DM body.
//   - zero_drafts_from_nonzero_data: pulls have rows, drafts empty.
//   - integration_auth_expired: LLM surfaces expired_provider.
//   - sixty_second_cap_hit: LLM took longer than the hard cap; partial
//     DM body with the MORE affordance.
//   - slack_post_failed: LLM produced drafts but slack send returned
//     null; reason flips, drafts still persist.
//   - persona_unknown: silently skipped; no DM, no ledger write.
//   - fire_already_completed: silent skip when ledger says completed.

import { describe, expect, test } from "bun:test";
import {
	type DraftSink,
	type FirstHourLedgerSink,
	type LlmTurnCaller,
	type LlmTurnResult,
	type RunFirstHourDeps,
	type SlackDmSender,
	runFirstHourOfWorkOnFirstboot,
} from "../runner.ts";
import type { AuditEvent, DraftKind } from "../types.ts";

interface Recorder {
	deps: RunFirstHourDeps;
	dmCalls: { userId: string; text: string; blocks: unknown[] }[];
	persistCalls: { fire_id: string; persona_id: string; drafts: { kind: DraftKind; body: string }[] }[];
	postControlCalls: number;
	auditEvents: AuditEvent[];
	ledgerStore: { started_at: string | null; completed_at: string | null; reason_code: string | null };
}

function makeDeps(opts: {
	llm: LlmTurnCaller;
	slackReturn?: string | null;
	slackThrow?: Error;
	ledgerCompleted?: boolean;
	available?: readonly string[];
	hardCapMs?: number;
	postControl?: () => Promise<void>;
}): Recorder {
	const dmCalls: { userId: string; text: string; blocks: unknown[] }[] = [];
	const persistCalls: { fire_id: string; persona_id: string; drafts: { kind: DraftKind; body: string }[] }[] = [];
	const auditEvents: AuditEvent[] = [];
	const ledgerStore = {
		started_at: null as string | null,
		completed_at: opts.ledgerCompleted ? new Date().toISOString() : (null as string | null),
		reason_code: null as string | null,
	};

	const slack: SlackDmSender = {
		sendBlocks: async (userId, text, blocks) => {
			if (opts.slackThrow) throw opts.slackThrow;
			dmCalls.push({ userId, text, blocks });
			return opts.slackReturn === undefined ? "ts.123456" : opts.slackReturn;
		},
	};

	let postControlCalls = 0;
	const drafts: DraftSink = {
		persistLocal: async (args) => {
			persistCalls.push({
				fire_id: args.fire_id,
				persona_id: args.persona_id,
				drafts: args.drafts.map((d) => ({ kind: d.kind, body: d.body })),
			});
			return args.drafts.map((d, i) => ({
				draft_id: `dft_${i}`,
				kind: d.kind,
				summary: d.summary,
			}));
		},
		postToControl: opts.postControl
			? async () => {
					postControlCalls++;
					await opts.postControl?.();
				}
			: undefined,
	};

	const ledger: FirstHourLedgerSink = {
		read: () => ({
			completed_at: ledgerStore.completed_at,
			started_at: ledgerStore.started_at,
		}),
		markStarted: (id) => {
			ledgerStore.started_at = new Date().toISOString();
			void id;
		},
		markCompleted: (reason) => {
			ledgerStore.completed_at = new Date().toISOString();
			ledgerStore.reason_code = reason;
		},
	};

	const recorder: Recorder = {
		deps: {
			llm: opts.llm,
			slack,
			drafts,
			ledger,
			audit: (e) => {
				auditEvents.push(e);
			},
			owner_user_id: "U_OWNER",
			dashboard_url: "https://app.ghostwright.dev",
			agent_id: "agent-1",
			hard_cap_ms_override: opts.hardCapMs,
			available_integrations_override: opts.available ?? ["slack", "github"],
		},
		dmCalls,
		persistCalls,
		get postControlCalls() {
			return postControlCalls;
		},
		auditEvents,
		ledgerStore,
	};

	return recorder;
}

const HAPPY_LLM: LlmTurnCaller = async () => ({
	pulls_executed: [
		{ source: "github", query: "search/issues", rows: 5 },
		{ source: "linear", query: "active sprint", rows: 3 },
	],
	saved_drafts: [
		{
			kind: "pr_comment" as DraftKind,
			summary: "PR #218 needs reviewer",
			body: "Hey, this has been open 3 days...",
			reference_url: "https://github.com/x/y/pull/218",
		},
		{
			kind: "standup_post" as DraftKind,
			summary: "Today's standup",
			body: "Yesterday: shipped X. Today: Y. Blockers: PR #218 still waiting on review.",
		},
	],
});

describe("runFirstHourOfWorkOnFirstboot", () => {
	test("happy path: drafts persisted, DM sent, 5 audit kinds fire in order", async () => {
		const r = makeDeps({ llm: HAPPY_LLM, available: ["slack", "github"] });
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "fixture",
				owner_email: "owner@fixture.test",
				owner_name: "Owner",
				fire_id: "fire_test_1",
			},
			r.deps,
		);
		expect(out.ok).toBe(true);
		expect(out.reason_code).toBe("ok");
		expect(out.drafts_created).toBe(2);
		expect(out.dm_message_id).toBe("ts.123456");
		expect(r.persistCalls).toHaveLength(1);
		expect(r.persistCalls[0].drafts).toHaveLength(2);
		expect(r.dmCalls).toHaveLength(1);
		expect(r.dmCalls[0].userId).toBe("U_OWNER");
		expect(r.ledgerStore.completed_at).not.toBeNull();
		expect(r.ledgerStore.reason_code).toBe("ok");
		// Audit kinds: start, 2x pulls, 2x drafts, dm, finish.
		const kinds = r.auditEvents.map((e) => e.kind);
		expect(kinds[0]).toBe("first_hour_of_work_start");
		expect(kinds.filter((k) => k === "first_hour_of_work_pulls")).toHaveLength(2);
		expect(kinds.filter((k) => k === "first_hour_of_work_drafts")).toHaveLength(2);
		expect(kinds.filter((k) => k === "first_hour_of_work_dm")).toHaveLength(1);
		expect(kinds[kinds.length - 1]).toBe("first_hour_of_work_finish");
	});

	test("happy path: postToControl is invoked once with the persisted ids", async () => {
		const r = makeDeps({
			llm: HAPPY_LLM,
			postControl: async () => {},
			available: ["slack", "github"],
		});
		await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "fixture",
				owner_email: "owner@fixture.test",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(r.postControlCalls).toBe(1);
	});

	test("no_integrations_granted: persona requires github, env has only slack", async () => {
		const llmCalled: { count: number } = { count: 0 };
		const r = makeDeps({
			llm: async () => {
				llmCalled.count++;
				return { pulls_executed: [], saved_drafts: [] };
			},
			available: ["slack"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("no_integrations_granted");
		expect(out.drafts_created).toBe(0);
		expect(llmCalled.count).toBe(0);
		expect(r.dmCalls).toHaveLength(1);
		expect(r.dmCalls[0].text).toContain("Marcus here.");
		expect(r.dmCalls[0].text).toContain("Connect GitHub");
		expect(r.ledgerStore.reason_code).toBe("no_integrations_granted");
	});

	test("all_pulls_zero_data: pulls succeed with zero rows", async () => {
		const r = makeDeps({
			llm: async () => ({
				pulls_executed: [
					{ source: "github", query: "search", rows: 0 },
					{ source: "linear", query: "issues", rows: 0 },
				],
				saved_drafts: [],
			}),
			available: ["slack", "github"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("all_pulls_zero_data");
		expect(out.drafts_created).toBe(0);
		expect(r.dmCalls).toHaveLength(1);
		expect(r.dmCalls[0].text).toContain("Marcus here.");
		expect(r.dmCalls[0].text).toContain("PRs and CI all green");
	});

	test("zero_drafts_from_nonzero_data: pulls have rows, drafts empty", async () => {
		const r = makeDeps({
			llm: async () => ({
				pulls_executed: [{ source: "github", query: "search", rows: 12 }],
				saved_drafts: [],
			}),
			available: ["slack", "github"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("zero_drafts_from_nonzero_data");
		expect(r.dmCalls).toHaveLength(1);
		expect(r.dmCalls[0].text).toContain("Marcus here.");
	});

	test("llm_error_mid_flow: LLM throws, runner ships degraded DM", async () => {
		const r = makeDeps({
			llm: async () => {
				throw new Error("model rate-limited");
			},
			available: ["slack", "github"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("llm_error_mid_flow");
		expect(r.dmCalls).toHaveLength(1);
		expect(r.dmCalls[0].text).toContain("Marcus here.");
		expect(r.dmCalls[0].text).toContain("RETRY");
	});

	test("integration_auth_expired: LLM surfaces expired_provider", async () => {
		const r = makeDeps({
			llm: async () => ({
				pulls_executed: [{ source: "github", query: "x", rows: 0, error_kind: "auth_failed" }],
				saved_drafts: [],
				expired_provider: "github",
			}),
			available: ["slack", "github"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("integration_auth_expired");
		expect(r.dmCalls[0].text).toContain("Marcus here.");
		expect(r.dmCalls[0].text).toContain("Github auth has expired");
	});

	test("sixty_second_cap_hit: hard cap fires, partial DM with MORE", async () => {
		const slowLlm: LlmTurnCaller = async (req) => {
			return await new Promise<LlmTurnResult>((resolve) => {
				const timeout = setTimeout(() => {
					resolve({
						pulls_executed: [{ source: "github", query: "x", rows: 5 }],
						saved_drafts: [
							{
								kind: "pr_comment" as DraftKind,
								summary: "comment",
								body: "body",
							},
						],
					});
				}, 5_000);
				req.signal.addEventListener("abort", () => {
					clearTimeout(timeout);
					resolve({
						pulls_executed: [{ source: "github", query: "x", rows: 5 }],
						saved_drafts: [
							{
								kind: "pr_comment" as DraftKind,
								summary: "partial",
								body: "saved before the cap fired",
							},
						],
					});
				});
			});
		};
		const r = makeDeps({
			llm: slowLlm,
			hardCapMs: 50,
			available: ["slack", "github"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("sixty_second_cap_hit");
		expect(r.dmCalls).toHaveLength(1);
		const blocks = r.dmCalls[0].blocks as Array<Record<string, unknown>>;
		const summary = blocks[1].text as Record<string, unknown>;
		expect(summary.text as string).toContain("reply MORE for the rest");
	});

	test("slack_post_failed: drafts persist but slack returns null", async () => {
		const r = makeDeps({
			llm: HAPPY_LLM,
			slackReturn: null,
			available: ["slack", "github"],
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("slack_post_failed");
		expect(r.persistCalls).toHaveLength(1);
		expect(r.persistCalls[0].drafts).toHaveLength(2);
		expect(r.dmCalls).toHaveLength(1);
		// dm audit event must NOT fire when message_id is null.
		const dmEvents = r.auditEvents.filter((e) => e.kind === "first_hour_of_work_dm");
		expect(dmEvents).toHaveLength(0);
	});

	test("persona_unknown: silent skip, no DM, audit finish only", async () => {
		const r = makeDeps({
			llm: async () => ({ pulls_executed: [], saved_drafts: [] }),
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "not-a-persona",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("persona_unknown");
		expect(r.dmCalls).toHaveLength(0);
		// Only one audit event fires: the finish row with persona_unknown.
		expect(r.auditEvents).toHaveLength(1);
		expect(r.auditEvents[0].kind).toBe("first_hour_of_work_finish");
	});

	test("fire_already_completed: silent skip when ledger has completed_at", async () => {
		const r = makeDeps({
			llm: async () => ({ pulls_executed: [], saved_drafts: [] }),
			ledgerCompleted: true,
		});
		const out = await runFirstHourOfWorkOnFirstboot(
			{
				persona_id: "eng-cos-marcus",
				tenant_slug: "f",
				owner_email: "owner@f",
				fire_id: "f1",
			},
			r.deps,
		);
		expect(out.reason_code).toBe("fire_already_completed");
		expect(r.dmCalls).toHaveLength(0);
		expect(r.auditEvents).toHaveLength(0);
	});

	test("happy path: every persona ships a DM with their voice", async () => {
		// Defense-in-depth: cycle every persona through the happy path
		// to confirm none of them produce a degraded DM through the
		// ok-reason branch. Slice 16 ships the 7-persona env contract;
		// slice 15a must not regress that.
		const ids = [
			"sdr-lilian",
			"eng-cos-marcus",
			"am-sloane",
			"bdr-theo",
			"sales-vp-priya",
			"gtm-eng-ryan",
			"founder-asst-adrian",
		];
		for (const id of ids) {
			const r = makeDeps({
				llm: async () => ({
					pulls_executed: [{ source: "slack-dm", query: "x", rows: 1 }],
					saved_drafts: [
						{
							kind: "slack_reply" as DraftKind,
							summary: "draft",
							body: "body",
						},
					],
				}),
				available: ["slack", "github", "calendar", "linear", "hubspot"],
			});
			const out = await runFirstHourOfWorkOnFirstboot(
				{
					persona_id: id,
					tenant_slug: "f",
					owner_email: "x@y",
					fire_id: `f_${id}`,
				},
				r.deps,
			);
			expect(out.reason_code).toBe("ok");
			expect(r.dmCalls).toHaveLength(1);
		}
	});
});
