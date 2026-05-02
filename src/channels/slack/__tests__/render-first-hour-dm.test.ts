// Block Kit renderer pin tests for the first-hour DM (architect §5).
//
// Pins:
//   - Block sequence: header + section + divider + (section + actions
//     + divider) per draft + actions (skip-all) + context.
//   - action_id pattern phantom:draft:{draft_id}:{action} for every
//     button across all 7 personas.
//   - block_id `draft_<draft_id>` on the per-draft actions row.
//   - block_id phantom_first_hour_skip_all on the skip-all row.
//   - Persona's intro_line lands in the header text.
//   - Persona's footer_line lands in the context block.
//   - Skip-all confirm dialog reflects the draft count.
//   - Fallback variant (no drafts): header + section [+ context].
//   - Partial variant (60s cap): section block prepends the MORE
//     affordance.
//   - Snapshot of one persona's full Block Kit JSON to catch shape drift.

import { describe, expect, test } from "bun:test";
import { PERSONA_WORK_PLAN_IDS, WORK_PLANS } from "../../../persona/work-plans.ts";
import {
	type FirstHourDmDraft,
	renderFirstHourDmBlocks,
	renderFirstHourDmFallbackBlocks,
	renderFirstHourDmFallbackText,
} from "../render-first-hour-dm.ts";

const SAMPLE_DRAFTS: FirstHourDmDraft[] = [
	{
		draft_id: "dft_01HX01",
		kind: "slack_reply",
		summary: "Reply to Acme Co's last message",
		body_preview: "Hi Sarah, thanks for the patience. Here's the v3 quote attached.",
		reference_url: "https://acme.example.com/thread/1",
	},
	{
		draft_id: "dft_01HX02",
		kind: "email_reply",
		summary: "Reply to Beta Co's pricing question",
		body_preview: "Beta team, attached is our updated pricing for the Q3 plan.",
	},
];

describe("renderFirstHourDmBlocks", () => {
	test("renders the standard shape: header + summary + drafts + skip-all + context", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			drafts: SAMPLE_DRAFTS,
			pull_summary: "I pulled 12 rows across slack-dm, calendar.",
			duration_seconds: 28,
		});
		// 1 header + 1 section + 1 divider + 2 drafts * 3 + 1 skip-all + 1 context
		expect(blocks).toHaveLength(1 + 1 + 1 + 2 * 3 + 1 + 1);
		expect(blocks[0].type).toBe("header");
		expect(blocks[1].type).toBe("section");
		expect(blocks[2].type).toBe("divider");
		expect(blocks[blocks.length - 2].type).toBe("actions");
		expect(blocks[blocks.length - 2].block_id).toBe("phantom_first_hour_skip_all");
		expect(blocks[blocks.length - 1].type).toBe("context");
	});

	test("each persona renders header text equal to intro_line", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const blocks = renderFirstHourDmBlocks({
				persona: WORK_PLANS[id],
				drafts: SAMPLE_DRAFTS,
				pull_summary: "summary",
				duration_seconds: 30,
			});
			const header = blocks[0] as Record<string, unknown>;
			const text = (header.text as Record<string, unknown>).text;
			expect(text).toBe(WORK_PLANS[id].intro_line);
		}
	});

	test("each persona renders footer_line in the context block", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const blocks = renderFirstHourDmBlocks({
				persona: WORK_PLANS[id],
				drafts: SAMPLE_DRAFTS,
				pull_summary: "summary",
				duration_seconds: 30,
			});
			const ctx = blocks[blocks.length - 1] as Record<string, unknown>;
			const elements = ctx.elements as Array<Record<string, unknown>>;
			expect((elements[0].text as string).startsWith(WORK_PLANS[id].footer_line)).toBe(true);
		}
	});

	test("button action_ids follow the phantom:draft:{id}:{action} pattern", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			drafts: SAMPLE_DRAFTS,
			pull_summary: "summary",
			duration_seconds: 30,
		});
		for (const draft of SAMPLE_DRAFTS) {
			const actions = blocks.find((b) => b.type === "actions" && b.block_id === `draft_${draft.draft_id}`) as
				| Record<string, unknown>
				| undefined;
			expect(actions).toBeDefined();
			const elements = actions?.elements as Array<Record<string, unknown>>;
			expect(elements).toHaveLength(3);
			const actionIds = elements.map((e) => e.action_id);
			expect(actionIds).toEqual([
				`phantom:draft:${draft.draft_id}:send`,
				`phantom:draft:${draft.draft_id}:edit`,
				`phantom:draft:${draft.draft_id}:skip`,
			]);
			expect(elements[0].style).toBe("primary");
		}
	});

	test("skip-all button has confirm dialog with draft count", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["am-sloane"],
			drafts: SAMPLE_DRAFTS,
			pull_summary: "summary",
			duration_seconds: 30,
		});
		const skipAll = blocks.find((b) => b.block_id === "phantom_first_hour_skip_all") as Record<string, unknown>;
		const elements = skipAll.elements as Array<Record<string, unknown>>;
		expect(elements[0].action_id).toBe("phantom:draft:all:skip_all");
		expect(elements[0].style).toBe("danger");
		const confirm = elements[0].confirm as Record<string, unknown>;
		expect((confirm.title as { text: string }).text).toBe("Skip all 2 drafts?");
	});

	test("partial=true prepends the MORE affordance", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			drafts: SAMPLE_DRAFTS,
			pull_summary: "I pulled 12 rows.",
			duration_seconds: 60,
			partial: true,
		});
		const summary = blocks[1] as Record<string, unknown>;
		const text = (summary.text as Record<string, unknown>).text as string;
		expect(text).toContain("I was still working when I had to send this; reply MORE for the rest");
	});

	test("dashboard_url + agent_id appends a See-all-in-dashboard link", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			drafts: SAMPLE_DRAFTS,
			pull_summary: "summary",
			duration_seconds: 30,
			dashboard_url: "https://app.ghostwright.dev",
			agent_id: "agent-123",
		});
		const ctx = blocks[blocks.length - 1] as Record<string, unknown>;
		const text = (ctx.elements as Array<Record<string, unknown>>)[0].text as string;
		expect(text).toContain("https://app.ghostwright.dev/agents/agent-123");
	});

	test("source link renders when reference_url is present", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			drafts: [SAMPLE_DRAFTS[0]],
			pull_summary: "summary",
			duration_seconds: 30,
		});
		const draftSection = blocks[3] as Record<string, unknown>;
		const text = (draftSection.text as Record<string, unknown>).text as string;
		expect(text).toContain("https://acme.example.com/thread/1");
	});

	test("snapshot: Lilian's full block kit shape", () => {
		const blocks = renderFirstHourDmBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			drafts: [SAMPLE_DRAFTS[0]],
			pull_summary: "I pulled 12 rows across slack-dm.",
			duration_seconds: 28,
		});
		expect(blocks).toMatchSnapshot();
	});

	test("snapshot: every persona's header + footer text shape", () => {
		const out: Record<string, unknown> = {};
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const blocks = renderFirstHourDmBlocks({
				persona: WORK_PLANS[id],
				drafts: [SAMPLE_DRAFTS[0]],
				pull_summary: "summary",
				duration_seconds: 30,
			});
			const header = blocks[0] as Record<string, unknown>;
			const ctx = blocks[blocks.length - 1] as Record<string, unknown>;
			out[id] = {
				header_text: (header.text as Record<string, unknown>).text,
				footer_text: (ctx.elements as Array<Record<string, unknown>>)[0].text,
			};
		}
		expect(out).toMatchSnapshot();
	});
});

describe("renderFirstHourDmFallbackBlocks", () => {
	test("renders header + section for each persona", () => {
		for (const id of PERSONA_WORK_PLAN_IDS) {
			const blocks = renderFirstHourDmFallbackBlocks({
				persona: WORK_PLANS[id],
				body: WORK_PLANS[id].fallback_dm_text,
			});
			expect(blocks).toHaveLength(2);
			expect(blocks[0].type).toBe("header");
			expect(blocks[1].type).toBe("section");
			const text = (blocks[1].text as Record<string, unknown>).text as string;
			expect(text).toBe(WORK_PLANS[id].fallback_dm_text);
		}
	});

	test("appends a context block when dashboard_url provided", () => {
		const blocks = renderFirstHourDmFallbackBlocks({
			persona: WORK_PLANS["sdr-lilian"],
			body: "Lilian here. Connect HubSpot.",
			dashboard_url: "https://app.ghostwright.dev",
		});
		expect(blocks).toHaveLength(3);
		expect(blocks[2].type).toBe("context");
	});

	test("snapshot: Marcus fallback block kit", () => {
		const blocks = renderFirstHourDmFallbackBlocks({
			persona: WORK_PLANS["eng-cos-marcus"],
			body: WORK_PLANS["eng-cos-marcus"].fallback_dm_text,
		});
		expect(blocks).toMatchSnapshot();
	});
});

describe("renderFirstHourDmFallbackText", () => {
	test("when no drafts, returns intro_line + fallback_dm_text", () => {
		const text = renderFirstHourDmFallbackText(WORK_PLANS["sdr-lilian"], 0);
		expect(text).toContain("Lilian here.");
		expect(text).toContain(WORK_PLANS["sdr-lilian"].fallback_dm_text);
	});

	test("when N drafts, summarizes + footer_line", () => {
		const text = renderFirstHourDmFallbackText(WORK_PLANS["sdr-lilian"], 3);
		expect(text).toContain("Lilian here.");
		expect(text).toContain("3 items");
		expect(text).toContain(WORK_PLANS["sdr-lilian"].footer_line);
	});

	test("singularizes 1 item", () => {
		const text = renderFirstHourDmFallbackText(WORK_PLANS["sdr-lilian"], 1);
		expect(text).toContain("1 item");
		expect(text).not.toContain("1 items");
	});
});
