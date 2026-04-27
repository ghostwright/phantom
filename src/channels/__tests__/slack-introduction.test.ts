import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { composeIntroductionText, sendIntroductionDm } from "../slack-introduction.ts";

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

beforeEach(() => {
	heartbeatCalls.length = 0;
	heartbeatThrows = null;
	process.env.METADATA_BASE_URL = "http://169.254.169.254";
	process.env.SLACK_TRANSPORT = "http";
	process.env.PHANTOM_DASHBOARD_URL = undefined;
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
});

describe("composeIntroductionText", () => {
	test("includes the phantom name and team name in the greeting", () => {
		const text = composeIntroductionText("Maple", "Acme Corp");
		expect(text).toContain("Hi! I'm Maple.");
		expect(text).toContain("connected to Acme Corp");
	});

	test("instructs the user how to interact with the agent", () => {
		const text = composeIntroductionText("Phantom", "Workspace");
		expect(text).toContain("Reply to this DM");
		expect(text).toContain("@-mention me");
	});

	test("omits the manage-me line when no dashboard URL is provided", () => {
		const text = composeIntroductionText("Phantom", "Workspace");
		expect(text).not.toContain("manage me");
	});

	test("includes the dashboard URL in the manage-me line when provided", () => {
		const text = composeIntroductionText("Phantom", "Workspace", "https://example.test/dashboard");
		expect(text).toContain("You can manage me at https://example.test/dashboard.");
	});
});

describe("sendIntroductionDm", () => {
	test("calls sendDm with the installer user id and the composed text", async () => {
		const sendDm = mock(async (_userId: string, _text: string) => "1715000000.000123" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Maple",
			teamName: "Acme Corp",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		expect(sendDm).toHaveBeenCalledTimes(1);
		const args = sendDm.mock.calls[0];
		if (!args) throw new Error("no call");
		expect(args[0]).toBe("U_INSTALLER");
		expect(args[1]).toContain("I'm Maple");
		expect(result.sent).toBe(true);
		expect(result.messageTs).toBe("1715000000.000123");
	});

	test("includes the dashboard URL when PHANTOM_DASHBOARD_URL is set to a valid URL", async () => {
		process.env.PHANTOM_DASHBOARD_URL = "https://example.test/manage";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000111" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Maple",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).toContain("You can manage me at https://example.test/manage.");
	});

	test("omits the manage-me line when PHANTOM_DASHBOARD_URL is unset (self-host)", async () => {
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000222" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Maple",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).not.toContain("manage me");
	});

	test("omits the manage-me line when PHANTOM_DASHBOARD_URL is malformed", async () => {
		process.env.PHANTOM_DASHBOARD_URL = "not a url";
		let captured = "";
		const sendDm = mock(async (_u: string, text: string) => {
			captured = text;
			return "1715000000.000333" as string | null;
		});
		await sendIntroductionDm({
			phantomName: "Maple",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});
		expect(captured).not.toContain("manage me");
	});

	test("acks first_dm_sent with the returned message_ts when SLACK_TRANSPORT=http", async () => {
		const sendDm = mock(async () => "1715000000.000456" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Maple",
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
			phantomName: "Maple",
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
			phantomName: "Maple",
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
			phantomName: "Maple",
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
			phantomName: "Maple",
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
			phantomName: "Maple",
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
				phantomName: "Maple",
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
