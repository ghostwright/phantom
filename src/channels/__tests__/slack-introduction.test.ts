import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { PERSONA_CATALOG, PERSONA_IDS, type PersonaId } from "../../persona/catalog.ts";
import type { SlackBlock } from "../feedback.ts";
import {
	MORNING_BRIEF_LOCK_ACTION_ID,
	MORNING_BRIEF_RETIME_ACTION_ID,
	MORNING_BRIEF_SKIP_ACTION_ID,
	composeIntroductionBlocks,
	composeIntroductionText,
	sendIntroductionDm,
} from "../slack-introduction.ts";

// Module-mock the heartbeat dependency before importing slack-introduction
// so its `await reportFirstDmSent(...)` call lands on our recorder. This
// pattern mirrors slack-http-receiver.test.ts's @slack/bolt mock: the
// behaviour-under-test is sendIntroductionDm itself; the heartbeat is a
// boundary we observe rather than a unit we exercise.
type HeartbeatCall = { metadataBaseUrl: string; slackMessageTs: string };
const heartbeatCalls: HeartbeatCall[] = [];
let heartbeatThrows: Error | null = null;

mock.module("../../tenancy/heartbeat.ts", () => ({
	reportFirstDmSent: mock(async (opts: { metadataBaseUrl: string; slackMessageTs: string }) => {
		heartbeatCalls.push({ metadataBaseUrl: opts.metadataBaseUrl, slackMessageTs: opts.slackMessageTs });
		if (heartbeatThrows) {
			const err = heartbeatThrows;
			heartbeatThrows = null;
			throw err;
		}
	}),
}));

const ORIGINAL_METADATA = process.env.METADATA_BASE_URL;
const ORIGINAL_TRANSPORT = process.env.SLACK_TRANSPORT;
const ORIGINAL_DASHBOARD = process.env.PHANTOM_DASHBOARD_URL;
const ORIGINAL_OWNER_NAME = process.env.PHANTOM_OWNER_NAME;
const ORIGINAL_DOMAIN = process.env.PHANTOM_DOMAIN;
const ORIGINAL_TENANT_SLUG = process.env.PHANTOM_TENANT_SLUG;
const ORIGINAL_PERSONA_ID = process.env.PHANTOM_PERSONA_ID;

beforeEach(() => {
	heartbeatCalls.length = 0;
	heartbeatThrows = null;
	process.env.METADATA_BASE_URL = "http://169.254.169.254";
	process.env.SLACK_TRANSPORT = "http";
	process.env.PHANTOM_DASHBOARD_URL = undefined;
	process.env.PHANTOM_OWNER_NAME = undefined;
	process.env.PHANTOM_DOMAIN = undefined;
	process.env.PHANTOM_TENANT_SLUG = undefined;
	process.env.PHANTOM_PERSONA_ID = undefined;
});

afterEach(() => {
	if (ORIGINAL_METADATA === undefined) {
		process.env.METADATA_BASE_URL = undefined;
	} else {
		process.env.METADATA_BASE_URL = ORIGINAL_METADATA;
	}
	if (ORIGINAL_TRANSPORT === undefined) {
		process.env.SLACK_TRANSPORT = undefined;
	} else {
		process.env.SLACK_TRANSPORT = ORIGINAL_TRANSPORT;
	}
	if (ORIGINAL_DASHBOARD === undefined) {
		process.env.PHANTOM_DASHBOARD_URL = undefined;
	} else {
		process.env.PHANTOM_DASHBOARD_URL = ORIGINAL_DASHBOARD;
	}
	if (ORIGINAL_OWNER_NAME === undefined) {
		process.env.PHANTOM_OWNER_NAME = undefined;
	} else {
		process.env.PHANTOM_OWNER_NAME = ORIGINAL_OWNER_NAME;
	}
	if (ORIGINAL_DOMAIN === undefined) {
		process.env.PHANTOM_DOMAIN = undefined;
	} else {
		process.env.PHANTOM_DOMAIN = ORIGINAL_DOMAIN;
	}
	if (ORIGINAL_TENANT_SLUG === undefined) {
		process.env.PHANTOM_TENANT_SLUG = undefined;
	} else {
		process.env.PHANTOM_TENANT_SLUG = ORIGINAL_TENANT_SLUG;
	}
	if (ORIGINAL_PERSONA_ID === undefined) {
		process.env.PHANTOM_PERSONA_ID = undefined;
	} else {
		process.env.PHANTOM_PERSONA_ID = ORIGINAL_PERSONA_ID;
	}
});

describe("composeIntroductionText", () => {
	test("greets the owner by name when PHANTOM_OWNER_NAME is provided", () => {
		const text = composeIntroductionText("Phantom", "Cheema", "https://gilded-hearth.phantom.ghostwright.dev");
		expect(text.startsWith("Hi Cheema. I'm in.")).toBe(true);
	});

	test("falls back to 'Hi there' when no owner name is provided", () => {
		const text = composeIntroductionText("Phantom", undefined, "https://gilded-hearth.phantom.ghostwright.dev");
		expect(text.startsWith("Hi there. I'm in.")).toBe(true);
	});

	test("identifies the agent as a co-worker, not a chatbot or assistant", () => {
		const text = composeIntroductionText("Phantom", "Cheema");
		expect(text).toContain("co-worker");
		expect(text).not.toContain("AI assistant");
		expect(text).not.toContain("I can help you with");
		expect(text).not.toContain("What would you like");
		expect(text).not.toContain("What can you do");
	});

	test("commits to the 8am morning brief as the proactive first action", () => {
		const text = composeIntroductionText("Phantom", "Cheema");
		expect(text).toContain("Tomorrow at 8am");
		expect(text).toContain("what changed overnight");
		// The text fallback nudges the user to the buttons rendered in
		// the Block Kit payload above it, so a screen reader does not
		// dead-end on the question.
		expect(text).toContain("Lock it in");
		expect(text).toContain("buttons below");
	});

	test("offers the user a way to start work right now if they prefer", () => {
		const text = composeIntroductionText("Phantom", "Cheema");
		expect(text).toContain("If you want me to start on something now, just tell me what.");
	});

	test("includes the home URL in the intro line when provided", () => {
		const text = composeIntroductionText("Phantom", "Cheema", "https://gilded-hearth.phantom.ghostwright.dev");
		expect(text).toContain("I live at https://gilded-hearth.phantom.ghostwright.dev");
	});

	test("omits the 'I live at' phrase when no home URL is provided", () => {
		const text = composeIntroductionText("Phantom", "Cheema");
		expect(text).not.toContain("I live at");
	});

	test("includes the dashboard URL footer when provided", () => {
		const text = composeIntroductionText(
			"Phantom",
			"Cheema",
			"https://gilded-hearth.phantom.ghostwright.dev",
			"https://app.ghostwright.dev",
		);
		expect(text).toContain("If you want to change anything about me, I live at https://app.ghostwright.dev.");
	});

	test("omits the dashboard footer when no dashboard URL is provided", () => {
		const text = composeIntroductionText("Phantom", "Cheema", "https://gilded-hearth.phantom.ghostwright.dev");
		expect(text).not.toContain("change anything about me");
	});

	test("never contains an em dash anywhere in the copy", () => {
		// Voice contract: em dashes are banned by the cardinal style rule.
		// Both U+2014 (em dash) and U+2013 (en dash) are flagged because
		// either reads as the same chatbot-formal voice we are leaving
		// behind.
		const variants = [
			composeIntroductionText("Phantom", "Cheema"),
			composeIntroductionText("Phantom", undefined, "https://example.test"),
			composeIntroductionText("Phantom", "Cheema", "https://example.test", "https://app.example.test"),
		];
		for (const text of variants) {
			expect(text).not.toContain("—");
			expect(text).not.toContain("–");
		}
	});

	test("never contains an emoji or marketing-voice phrase", () => {
		const text = composeIntroductionText(
			"Phantom",
			"Cheema",
			"https://gilded-hearth.phantom.ghostwright.dev",
			"https://app.ghostwright.dev",
		);
		expect(text).not.toContain("✨");
		expect(text).not.toContain("\u{1F44B}");
		expect(text).not.toContain("\u{1F680}");
		expect(text).not.toContain("Maximize");
		expect(text).not.toContain("blazing");
		expect(text).not.toContain("Welcome to the future");
	});
});

describe("composeIntroductionBlocks", () => {
	test("renders a header, body section, actions row, and offer section", () => {
		const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://gilded-hearth.phantom.ghostwright.dev");
		const header = blocks.find((b) => b.type === "header");
		const sections = blocks.filter((b) => b.type === "section");
		const actions = blocks.find((b) => b.type === "actions");
		expect(header).toBeDefined();
		expect(sections.length).toBeGreaterThanOrEqual(2);
		expect(actions).toBeDefined();
		expect(actions?.block_id).toBe("phantom_morning_brief");
	});

	test("the actions row carries exactly three buttons in lock-retime-skip order", () => {
		const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test");
		const actions = blocks.find((b) => b.type === "actions") as SlackBlock & {
			elements?: Array<{ action_id?: string; text?: { text?: string }; style?: string; value?: string }>;
		};
		expect(actions?.elements?.length).toBe(3);
		const ids = actions?.elements?.map((e) => e.action_id);
		expect(ids).toEqual([MORNING_BRIEF_LOCK_ACTION_ID, MORNING_BRIEF_RETIME_ACTION_ID, MORNING_BRIEF_SKIP_ACTION_ID]);
		expect(actions?.elements?.[0]?.text?.text).toBe("Lock 8am");
		expect(actions?.elements?.[0]?.style).toBe("primary");
		expect(actions?.elements?.[1]?.text?.text).toBe("Pick another time");
		expect(actions?.elements?.[2]?.text?.text).toBe("Skip mornings");
	});

	test("the dashboard context block appears only when a dashboard URL is set", () => {
		const without = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test");
		const withDash = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test", "https://app.example.test");
		expect(without.some((b) => b.type === "context")).toBe(false);
		expect(withDash.some((b) => b.type === "context")).toBe(true);
	});

	test("the body section uses the named greeting when an owner name is provided", () => {
		const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test");
		const bodySection = blocks.find((b) => b.type === "section" && (b.text?.text ?? "").includes("co-worker"));
		expect(bodySection?.text?.text).toContain("Hi Cheema.");
	});

	test("the body section falls back to 'Hi there' when no owner name is provided", () => {
		const blocks = composeIntroductionBlocks("Phantom", undefined, "https://example.test");
		const bodySection = blocks.find((b) => b.type === "section" && (b.text?.text ?? "").includes("co-worker"));
		expect(bodySection?.text?.text).toContain("Hi there.");
	});

	test("the header uses the agent's name", () => {
		const blocks = composeIntroductionBlocks("Maple", "Cheema", "https://example.test");
		const header = blocks.find((b) => b.type === "header");
		expect(header?.text?.text).toBe("Maple is in.");
	});
});

describe("sendIntroductionDm", () => {
	test("calls sendDm with the installer user id, text fallback, and Block Kit blocks", async () => {
		process.env.PHANTOM_OWNER_NAME = "Cheema";
		process.env.PHANTOM_DOMAIN = "gilded-hearth.phantom.ghostwright.dev";
		const sendDm = mock(
			async (_userId: string, _text: string, _blocks?: SlackBlock[]) => "1715000000.000123" as string | null,
		);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme Corp",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(sendDm).toHaveBeenCalledTimes(1);
		const args = sendDm.mock.calls[0];
		if (!args) throw new Error("no call");
		expect(args[0]).toBe("U_INSTALLER");
		expect(args[1]).toContain("Hi Cheema.");
		expect(args[1]).toContain("co-worker");
		const blocks = args[2] as SlackBlock[] | undefined;
		expect(Array.isArray(blocks)).toBe(true);
		const actions = blocks?.find((b) => b.type === "actions");
		expect(actions?.block_id).toBe("phantom_morning_brief");
		expect(result.sent).toBe(true);
		expect(result.messageTs).toBe("1715000000.000123");
	});

	test("derives the home URL from PHANTOM_DOMAIN when set", async () => {
		process.env.PHANTOM_OWNER_NAME = "Cheema";
		process.env.PHANTOM_DOMAIN = "gilded-hearth.phantom.ghostwright.dev";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000111" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).toContain("I live at https://gilded-hearth.phantom.ghostwright.dev");
	});

	test("derives the home URL from PHANTOM_TENANT_SLUG when PHANTOM_DOMAIN is unset", async () => {
		process.env.PHANTOM_TENANT_SLUG = "gilded-hearth";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000222" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).toContain("I live at https://gilded-hearth.phantom.ghostwright.dev");
	});

	test("strips a leading https:// from PHANTOM_DOMAIN before building the URL", async () => {
		process.env.PHANTOM_DOMAIN = "https://gilded-hearth.phantom.ghostwright.dev/";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000333" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).not.toContain("https://https://");
		expect(captured).toContain("I live at https://gilded-hearth.phantom.ghostwright.dev");
	});

	test("includes the dashboard URL footer when PHANTOM_DASHBOARD_URL is set", async () => {
		process.env.PHANTOM_DASHBOARD_URL = "https://app.ghostwright.dev";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000444" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).toContain("If you want to change anything about me, I live at https://app.ghostwright.dev.");
	});

	test("omits the dashboard footer when PHANTOM_DASHBOARD_URL is malformed", async () => {
		process.env.PHANTOM_DASHBOARD_URL = "not a url";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000555" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).not.toContain("change anything about me");
	});

	test("omits the dashboard footer when PHANTOM_DASHBOARD_URL is unset (self-host)", async () => {
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000666" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).not.toContain("change anything about me");
	});

	test("acks first_dm_sent with the returned message_ts when SLACK_TRANSPORT=http", async () => {
		const sendDm = mock(async () => "1715000000.000456" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(result.sent).toBe(true);
		expect(heartbeatCalls.length).toBe(1);
		const call = heartbeatCalls[0];
		if (!call) throw new Error("no heartbeat");
		expect(call.metadataBaseUrl).toBe("http://169.254.169.254");
		expect(call.slackMessageTs).toBe("1715000000.000456");
	});

	test("acks first_dm_sent with the default metadata URL when METADATA_BASE_URL is unset but SLACK_TRANSPORT=http", async () => {
		// SLACK_TRANSPORT=http is the actual signal that the agent is in
		// an operator-managed deployment. METADATA_BASE_URL may be unset
		// in that deployment because the channel factory defaults to the
		// link-local address; the heartbeat must follow the same
		// fallback.
		process.env.METADATA_BASE_URL = undefined;
		const sendDm = mock(async () => "1715000000.000789" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(result.sent).toBe(true);
		expect(heartbeatCalls.length).toBe(1);
		const call = heartbeatCalls[0];
		if (!call) throw new Error("no heartbeat");
		expect(call.metadataBaseUrl).toBe("http://169.254.169.254");
	});

	test("skips the first_dm_sent ack when SLACK_TRANSPORT is unset (self-host Socket Mode default)", async () => {
		process.env.SLACK_TRANSPORT = undefined;
		const sendDm = mock(async () => "1715000000.000900" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		// The DM still sends; only the heartbeat is gated on the
		// transport mode. Self-hosters never run inside an
		// operator-managed VM, so there is no listener for the signal.
		expect(result.sent).toBe(true);
		expect(heartbeatCalls.length).toBe(0);
	});

	test("skips the first_dm_sent ack when SLACK_TRANSPORT=socket (explicit self-host)", async () => {
		process.env.SLACK_TRANSPORT = "socket";
		const sendDm = mock(async () => "1715000000.000901" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(result.sent).toBe(true);
		expect(heartbeatCalls.length).toBe(0);
	});

	test("acks first_dm_sent when SLACK_TRANSPORT is whitespace-padded http (trim parity with factory)", async () => {
		// readSlackTransportFromEnv() trims before deciding transport, so
		// SLACK_TRANSPORT="  http  " selects the HTTP receiver. The gate
		// here must use the same normalization or the heartbeat is
		// skipped while the receiver runs, leaving activation pending.
		process.env.SLACK_TRANSPORT = "  http  ";
		const sendDm = mock(async () => "1715000000.000902" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(result.sent).toBe(true);
		expect(heartbeatCalls.length).toBe(1);
		const call = heartbeatCalls[0];
		if (!call) throw new Error("no heartbeat");
		expect(call.slackMessageTs).toBe("1715000000.000902");
	});

	test("skips first_dm_sent when SLACK_TRANSPORT is empty string (treated as socket default)", async () => {
		process.env.SLACK_TRANSPORT = "";
		const sendDm = mock(async () => "1715000000.000903" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(result.sent).toBe(true);
		expect(heartbeatCalls.length).toBe(0);
	});

	test("returns sent:false and skips heartbeat when sendDm returns null (Slack rate limit)", async () => {
		const sendDm = mock(async () => null);
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(result.sent).toBe(false);
		expect(result.messageTs).toBeNull();
		// No ts means no audit signal the host gateway can record. The
		// caller's failed_first_dm path picks up the timeout
		// independently via the operator's poll loop.
		expect(heartbeatCalls.length).toBe(0);
	});

	test("returns sent:false when sendDm throws (network down, token revoked)", async () => {
		const sendDm = mock(async () => {
			throw new Error("ECONNREFUSED");
		});
		const result = await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		// Errors are swallowed so connect()'s caller stays successful. The
		// log line surfaces the failure for operator triage.
		expect(result.sent).toBe(false);
		expect(heartbeatCalls.length).toBe(0);
	});

	test("redacts a leaked bot token if it appears in a thrown error message", async () => {
		const sendDm = mock(async () => {
			throw new Error("postMessage failed: xoxb-leaky-token-XXX in body");
		});
		const errors: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		};
		try {
			await sendIntroductionDm({
				phantomName: "Phantom",
				teamName: "Acme",
				installerUserId: "U_INSTALLER",
				sendDm,
			});
		} finally {
			console.error = original;
		}

		// Defense in depth: the redactTokens helper that the connect path
		// already trusts is the same one used here; confirm the contract.
		const all = errors.join("\n");
		expect(all).toContain("postMessage failed");
		expect(all).not.toContain("xoxb-leaky-token-XXX");
	});
});

// Slice 16b: persona overlay coverage.
//
// The wire shape from PR #120 (Block Kit header + body section + actions
// row + offer section + optional context footer) STAYS THE SAME under
// the persona overlay. The actions row block_id, the three button
// action_ids, the primary style on Lock 8am, and the order of the
// buttons stay byte-equal across every persona AND the persona-less
// fallback. The text content shifts to the persona's display_name +
// intro_role_phrase + intro_first_commitment + intro_open_offer.

describe("composeIntroductionText with persona overlay", () => {
	for (const id of PERSONA_IDS) {
		const persona = PERSONA_CATALOG[id];
		test(`${id} text fallback uses the persona's named greeting + role phrase + first_commitment + open_offer`, () => {
			const text = composeIntroductionText(
				"Phantom",
				"Cheema",
				"https://gilded-hearth.phantom.ghostwright.dev",
				undefined,
				persona,
			);
			expect(text).toContain(`I'm ${persona.display_name}, ${persona.intro_role_phrase}.`);
			expect(text).toContain(persona.intro_first_commitment);
			expect(text).toContain(persona.intro_open_offer);
			// The wire-shape cue ("buttons below") stays so screen-reader
			// users do not dead-end at the question regardless of persona.
			expect(text).toContain("buttons below");
		});
	}

	test("falls back to the PR #120 default copy when no persona is provided", () => {
		const text = composeIntroductionText(
			"Phantom",
			"Cheema",
			"https://gilded-hearth.phantom.ghostwright.dev",
			undefined,
			undefined,
		);
		expect(text).toContain("I'm in.");
		expect(text).toContain("co-worker in this Slack as Phantom");
		expect(text).toContain(
			"Tomorrow at 8am your time I'll send you a quick read on what changed overnight and what needs you",
		);
		expect(text).toContain("If you want me to start on something now, just tell me what.");
	});

	test("never contains an em dash, en dash, or marketing voice across all seven personas", () => {
		for (const id of PERSONA_IDS) {
			const persona = PERSONA_CATALOG[id];
			const text = composeIntroductionText(
				"Phantom",
				"Cheema",
				"https://gilded-hearth.phantom.ghostwright.dev",
				"https://app.ghostwright.dev",
				persona,
			);
			expect(text).not.toContain("—");
			expect(text).not.toContain("–");
			expect(text).not.toContain("blazing");
			expect(text).not.toContain("Welcome to the future");
			expect(text).not.toContain("✨");
		}
	});
});

describe("composeIntroductionBlocks with persona overlay", () => {
	for (const id of PERSONA_IDS) {
		const persona = PERSONA_CATALOG[id];
		test(`${id} header text uses the persona's display_name`, () => {
			const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test", undefined, persona);
			const header = blocks.find((b) => b.type === "header");
			expect(header?.text?.text).toBe(`${persona.display_name} is in.`);
		});

		test(`${id} body section identifies the agent by display_name + role_phrase`, () => {
			const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test", undefined, persona);
			const bodySection = blocks.find(
				(b) => b.type === "section" && (b.text?.text ?? "").includes("I'll be in this Slack"),
			);
			expect(bodySection).toBeDefined();
			expect(bodySection?.text?.text).toContain(persona.display_name);
			expect(bodySection?.text?.text).toContain(persona.intro_role_phrase);
			expect(bodySection?.text?.text).toContain(persona.intro_first_commitment);
		});

		test(`${id} offer section uses the persona's intro_open_offer`, () => {
			const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test", undefined, persona);
			const offerSection = blocks.find(
				(b) => b.type === "section" && (b.text?.text ?? "").includes(persona.intro_open_offer),
			);
			expect(offerSection).toBeDefined();
		});

		test(`${id} preserves the exact PR #120 actions wire shape (block_id, action_ids, primary on Lock 8am)`, () => {
			const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test", undefined, persona);
			const actions = blocks.find((b) => b.type === "actions") as SlackBlock & {
				elements?: Array<{ action_id?: string; text?: { text?: string }; style?: string; value?: string }>;
			};
			expect(actions?.block_id).toBe("phantom_morning_brief");
			expect(actions?.elements?.length).toBe(3);
			expect(actions?.elements?.map((e) => e.action_id)).toEqual([
				MORNING_BRIEF_LOCK_ACTION_ID,
				MORNING_BRIEF_RETIME_ACTION_ID,
				MORNING_BRIEF_SKIP_ACTION_ID,
			]);
			expect(actions?.elements?.[0]?.style).toBe("primary");
			expect(actions?.elements?.[0]?.text?.text).toBe("Lock 8am");
			expect(actions?.elements?.[1]?.text?.text).toBe("Pick another time");
			expect(actions?.elements?.[2]?.text?.text).toBe("Skip mornings");
		});
	}

	test("default header (no persona) keeps the PR #120 phantomName-driven copy", () => {
		const blocks = composeIntroductionBlocks("Phantom", "Cheema", "https://example.test", undefined, undefined);
		const header = blocks.find((b) => b.type === "header");
		expect(header?.text?.text).toBe("Phantom is in.");
	});

	test("dashboard context footer renders for any persona when PHANTOM_DASHBOARD_URL is set", () => {
		for (const id of PERSONA_IDS) {
			const persona = PERSONA_CATALOG[id];
			const blocks = composeIntroductionBlocks(
				"Phantom",
				"Cheema",
				"https://example.test",
				"https://app.ghostwright.dev",
				persona,
			);
			expect(blocks.some((b) => b.type === "context")).toBe(true);
		}
	});
});

describe("sendIntroductionDm reads PHANTOM_PERSONA_ID and threads the persona through", () => {
	for (const id of PERSONA_IDS as readonly PersonaId[]) {
		const persona = PERSONA_CATALOG[id];
		test(`${id}: PHANTOM_PERSONA_ID drives the persona's display_name in the header and the body sentence`, async () => {
			process.env.PHANTOM_OWNER_NAME = "Cheema";
			process.env.PHANTOM_DOMAIN = "gilded-hearth.phantom.ghostwright.dev";
			process.env.PHANTOM_PERSONA_ID = id;
			let capturedText = "";
			let capturedBlocks: SlackBlock[] | undefined;
			const sendDm = mock(async (_userId: string, text: string, blocks?: SlackBlock[]) => {
				capturedText = text;
				capturedBlocks = blocks;
				return "1715000000.999000" as string | null;
			});
			const result = await sendIntroductionDm({
				phantomName: "Phantom",
				teamName: "Acme",
				installerUserId: "U_INSTALLER",
				sendDm,
			});

			expect(result.sent).toBe(true);
			expect(capturedText).toContain(`I'm ${persona.display_name}, ${persona.intro_role_phrase}.`);
			expect(capturedText).toContain(persona.intro_first_commitment);
			expect(capturedText).toContain(persona.intro_open_offer);
			const header = capturedBlocks?.find((b) => b.type === "header");
			expect(header?.text?.text).toBe(`${persona.display_name} is in.`);
			const actions = capturedBlocks?.find((b) => b.type === "actions");
			expect(actions?.block_id).toBe("phantom_morning_brief");
		});
	}

	test("falls back to default scaffold when PHANTOM_PERSONA_ID is unset", async () => {
		process.env.PHANTOM_OWNER_NAME = "Cheema";
		process.env.PHANTOM_DOMAIN = "gilded-hearth.phantom.ghostwright.dev";
		let capturedText = "";
		let capturedBlocks: SlackBlock[] | undefined;
		const sendDm = mock(async (_userId: string, text: string, blocks?: SlackBlock[]) => {
			capturedText = text;
			capturedBlocks = blocks;
			return "1715000000.998000" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(capturedText).toContain("co-worker in this Slack as Phantom");
		expect(capturedText).toContain(
			"Tomorrow at 8am your time I'll send you a quick read on what changed overnight and what needs you",
		);
		const header = capturedBlocks?.find((b) => b.type === "header");
		expect(header?.text?.text).toBe("Phantom is in.");
	});

	test("falls back to default scaffold when PHANTOM_PERSONA_ID is unknown (defends against typos and validator drift)", async () => {
		process.env.PHANTOM_OWNER_NAME = "Cheema";
		process.env.PHANTOM_PERSONA_ID = "sdr-typo";
		let capturedText = "";
		const sendDm = mock(async (_userId: string, text: string, _blocks?: SlackBlock[]) => {
			capturedText = text;
			return "1715000000.997000" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(capturedText).toContain("co-worker in this Slack as Phantom");
		expect(capturedText).not.toContain("sdr-typo");
	});

	test("falls back to default scaffold when PHANTOM_PERSONA_ID is empty string", async () => {
		process.env.PHANTOM_PERSONA_ID = "";
		let capturedText = "";
		const sendDm = mock(async (_userId: string, text: string, _blocks?: SlackBlock[]) => {
			capturedText = text;
			return "1715000000.996000" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Phantom",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(capturedText).toContain("co-worker in this Slack as Phantom");
	});
});

describe("intro DM Block Kit snapshot per persona", () => {
	// Snapshot test (architect doc §6 Mandate E): each persona's rendered
	// Block Kit JSON. We pin the structural shape (header + sections +
	// actions + optional context) plus the persona-specific copy that
	// shifts in each block. This catches accidental drift between
	// persona text content and the block scaffolding without coupling
	// to Slack's wire format minutiae.
	for (const id of PERSONA_IDS) {
		const persona = PERSONA_CATALOG[id];
		test(`${id} renders the locked Block Kit shape with persona-specific copy`, () => {
			const blocks = composeIntroductionBlocks(
				"Phantom",
				"Cheema",
				"https://gilded-hearth.phantom.ghostwright.dev",
				"https://app.ghostwright.dev",
				persona,
			);
			// Shape: header + body section + actions + offer section + context.
			expect(blocks.length).toBe(5);
			expect(blocks[0]?.type).toBe("header");
			expect(blocks[1]?.type).toBe("section");
			expect(blocks[2]?.type).toBe("actions");
			expect(blocks[3]?.type).toBe("section");
			expect(blocks[4]?.type).toBe("context");
			// Persona-specific content lands in the right blocks.
			expect(blocks[0]?.text?.text).toBe(`${persona.display_name} is in.`);
			expect(blocks[1]?.text?.text).toContain(persona.display_name);
			expect(blocks[1]?.text?.text).toContain(persona.intro_role_phrase);
			expect(blocks[1]?.text?.text).toContain(persona.intro_first_commitment);
			expect(blocks[3]?.text?.text).toContain(persona.intro_open_offer);
		});
	}
});
