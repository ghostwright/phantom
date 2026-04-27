import { describe, expect, test } from "bun:test";
import { type FetchImpl, reportAgentReady, reportFirstDmSent } from "../heartbeat.ts";

// Build a fetch double that records every call and returns a response
// matching the test's expectations. The metadata gateway returns 204 No
// Content on success; we shape the double to mirror that wire.
//
// We type the function directly as FetchImpl rather than wrapping in
// bun:test's `mock()` helper. The mock() wrapper introduces internal
// reset state that has shifted across Bun minor versions; a plain
// async function carries no per-runtime state and behaves identically
// across describe blocks on every Bun release.
type RecordedCall = { url: string; init: RequestInit };

function makeFetchOk(): { fn: FetchImpl; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn: FetchImpl = async (url, init) => {
		calls.push({ url, init });
		return new Response(null, { status: 204 });
	};
	return { fn, calls };
}

function makeFetchStatus(status: number): { fn: FetchImpl; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn: FetchImpl = async (url, init) => {
		calls.push({ url, init });
		return new Response(null, { status });
	};
	return { fn, calls };
}

function makeFetchThrows(err: Error): { fn: FetchImpl; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fn: FetchImpl = async (url, init) => {
		calls.push({ url, init });
		throw err;
	};
	return { fn, calls };
}

describe("reportAgentReady", () => {
	test("POSTs to /v1/tenant_status/agent_ready with the transport in the body", async () => {
		const { fn, calls } = makeFetchOk();

		await reportAgentReady({
			metadataBaseUrl: "http://169.254.169.254",
			transport: "http",
			fetchImpl: fn,
		});

		expect(calls.length).toBe(1);
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.url).toBe("http://169.254.169.254/v1/tenant_status/agent_ready");
		expect(call.init.method).toBe("POST");
		const headers = call.init.headers as Record<string, string>;
		expect(headers["content-type"]).toBe("application/json");
		// The host gateway parses ONLY the `transport` field out of the
		// agent_ready body. Any extra fields are ignored.
		const body = JSON.parse(call.init.body as string);
		expect(body).toEqual({ transport: "http" });
	});

	test("trims a trailing slash on the base URL so the gateway mux matches", async () => {
		const { fn, calls } = makeFetchOk();

		await reportAgentReady({
			metadataBaseUrl: "http://169.254.169.254/",
			transport: "http",
			fetchImpl: fn,
		});

		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.url).toBe("http://169.254.169.254/v1/tenant_status/agent_ready");
	});

	test("does not throw when the gateway returns a non-2xx status", async () => {
		const { fn } = makeFetchStatus(503);

		// reportAgentReady is best-effort. A 503 logs a warning; phantom keeps
		// running. WaitTenantReady's timeout is the operator-visible signal.
		await expect(
			reportAgentReady({
				metadataBaseUrl: "http://169.254.169.254",
				transport: "http",
				fetchImpl: fn,
			}),
		).resolves.toBeUndefined();
	});

	test("does not throw when fetch itself rejects (network error)", async () => {
		const { fn } = makeFetchThrows(new Error("ECONNREFUSED"));

		await expect(
			reportAgentReady({
				metadataBaseUrl: "http://169.254.169.254",
				transport: "http",
				fetchImpl: fn,
			}),
		).resolves.toBeUndefined();
	});
});

describe("reportFirstDmSent", () => {
	test("POSTs to /v1/tenant_status/first_dm_sent with the slack_message_ts", async () => {
		const { fn, calls } = makeFetchOk();

		await reportFirstDmSent({
			metadataBaseUrl: "http://169.254.169.254",
			slackMessageTs: "1715000000.000123",
			fetchImpl: fn,
		});

		expect(calls.length).toBe(1);
		const call = calls[0];
		if (!call) throw new Error("no call");
		expect(call.url).toBe("http://169.254.169.254/v1/tenant_status/first_dm_sent");
		expect(call.init.method).toBe("POST");
		// The host gateway 400s if slack_message_ts is empty. We send
		// only that field to match the parsed envelope shape exactly.
		const body = JSON.parse(call.init.body as string);
		expect(body).toEqual({ slack_message_ts: "1715000000.000123" });
	});

	test("skips the POST when slack_message_ts is empty (caller must guard)", async () => {
		const { fn, calls } = makeFetchOk();

		await reportFirstDmSent({
			metadataBaseUrl: "http://169.254.169.254",
			slackMessageTs: "",
			fetchImpl: fn,
		});

		// An empty ts would 400 at the host gateway. We catch that at
		// the source so the caller's no-DM case never produces a
		// misleading audit entry.
		expect(calls.length).toBe(0);
	});

	test("does not throw on a non-2xx response (best-effort)", async () => {
		const { fn } = makeFetchStatus(500);

		await expect(
			reportFirstDmSent({
				metadataBaseUrl: "http://169.254.169.254",
				slackMessageTs: "1715000000.000123",
				fetchImpl: fn,
			}),
		).resolves.toBeUndefined();
	});

	test("does not throw on a fetch rejection", async () => {
		const { fn } = makeFetchThrows(new Error("network down"));

		await expect(
			reportFirstDmSent({
				metadataBaseUrl: "http://169.254.169.254",
				slackMessageTs: "1715000000.000123",
				fetchImpl: fn,
			}),
		).resolves.toBeUndefined();
	});
});
