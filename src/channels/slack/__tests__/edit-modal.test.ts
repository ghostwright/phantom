// Tests for the views.open payload of the draft edit modal.

import { describe, expect, test } from "bun:test";
import {
	DRAFT_BODY_BLOCK_ID,
	DRAFT_BODY_INPUT_ACTION_ID,
	EDIT_MODAL_CALLBACK_ID,
	buildEditModalView,
} from "../edit-modal.ts";

describe("buildEditModalView", () => {
	test("renders a modal with the standard callback_id and private_metadata", () => {
		const view = buildEditModalView({
			draft_id: "dft_01",
			draft_kind: "slack_reply",
			current_body: "Hi Sarah, ...",
			persona_intro_line: "Lilian here.",
		});
		expect(view.type).toBe("modal");
		expect(view.callback_id).toBe(EDIT_MODAL_CALLBACK_ID);
		expect(view.private_metadata).toBe("dft_01");
		expect(view.title.text).toBe("Edit draft");
	});

	test("renders the body input with the correct block_id and action_id", () => {
		const view = buildEditModalView({
			draft_id: "dft_01",
			draft_kind: "slack_reply",
			current_body: "Hi Sarah",
			persona_intro_line: "Lilian here.",
		});
		const input = view.blocks.find((b) => (b as Record<string, unknown>).block_id === DRAFT_BODY_BLOCK_ID) as Record<
			string,
			unknown
		>;
		expect(input).toBeDefined();
		const element = input.element as Record<string, unknown>;
		expect(element.action_id).toBe(DRAFT_BODY_INPUT_ACTION_ID);
		expect(element.initial_value).toBe("Hi Sarah");
		expect(element.multiline).toBe(true);
		expect(element.max_length).toBe(4000);
	});

	test("renders edit_hints when provided", () => {
		const view = buildEditModalView({
			draft_id: "dft_01",
			draft_kind: "slack_reply",
			current_body: "x",
			edit_hints: "tighten the ask",
			persona_intro_line: "Lilian here.",
		});
		const intro = view.blocks[0] as Record<string, unknown>;
		const text = (intro.text as Record<string, unknown>).text as string;
		expect(text).toContain("tighten the ask");
		expect(text).toContain("Lilian");
	});

	test("renders the Save without sending button with the persona action id pattern", () => {
		const view = buildEditModalView({
			draft_id: "dft_01",
			draft_kind: "slack_reply",
			current_body: "x",
			persona_intro_line: "Lilian here.",
		});
		const actions = view.blocks.find((b) => (b as Record<string, unknown>).block_id === "edit_save_only") as Record<
			string,
			unknown
		>;
		const elements = actions.elements as Array<Record<string, unknown>>;
		expect(elements[0].action_id).toBe("phantom:draft:dft_01:save_only");
	});

	test("humanizes draft kinds in the header", () => {
		const view = buildEditModalView({
			draft_id: "dft_01",
			draft_kind: "pr_comment",
			current_body: "x",
			persona_intro_line: "Marcus here.",
		});
		const intro = view.blocks[0] as Record<string, unknown>;
		const text = (intro.text as Record<string, unknown>).text as string;
		expect(text).toContain("PR comment");
	});

	test("snapshot of the modal payload", () => {
		const view = buildEditModalView({
			draft_id: "dft_01J",
			draft_kind: "slack_reply",
			current_body: "Hi Sarah, here is the v3 quote.",
			edit_hints: "tighten the ask",
			persona_intro_line: "Lilian here.",
		});
		expect(view).toMatchSnapshot();
	});
});
