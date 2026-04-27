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

beforeEach(() => {
	heartbeatCalls.length = 0;
	heartbeatThrows = null;
	process.env.METADATA_BASE_URL = "http://169.254.169.254";
});

afterEach(() => {
	if (ORIGINAL_METADATA === undefined) {
		process.env.METADATA_BASE_URL = undefined;
	} else {
		process.env.METADATA_BASE_URL = ORIGINAL_METADATA;
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

	test("links to the dashboard for management", () => {
		const text = composeIntroductionText("Phantom", "Workspace");
		expect(text).toContain("https://ghostwright.dev/phantom/dashboard");
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

	test("acks first_dm_sent with the returned message_ts when METADATA_BASE_URL is set", async () => {
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

	test("skips the first_dm_sent ack when METADATA_BASE_URL is unset (self-host)", async () => {
		process.env.METADATA_BASE_URL = undefined;
		const sendDm = mock(async () => "1715000000.000789" as string | null);
		const result = await sendIntroductionDm({
			phantomName: "Maple",
			teamName: "Acme",
			installerUserId: "U_INSTALLER",
			sendDm,
		});

		// The DM still sends; only the heartbeat is gated on metadata. Self-
		// hosters never run inside a phantomd-managed VM, so no listener.
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
		// No ts means no audit signal phantomd can record. The wizard's
		// failed_first_dm path picks up the timeout via phantom-control.
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
