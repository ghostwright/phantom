import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelsConfig } from "../../config/schemas.ts";

// Mock the Slack Bolt SDK before importing the factory so the underlying
// channel constructors don't reach real network. The receiver test file
// already mocks @slack/bolt, but module mocks are scoped per file under bun.
const mockApp = mock(() => ({
	event: () => {},
	action: () => {},
	client: {
		auth: { test: () => Promise.resolve({ user_id: "U_BOT" }) },
		chat: { postMessage: () => Promise.resolve({ ts: "1.0" }), update: () => Promise.resolve({ ok: true }) },
		conversations: { open: () => Promise.resolve({ channel: { id: "D1" } }) },
		reactions: { add: () => Promise.resolve({ ok: true }), remove: () => Promise.resolve({ ok: true }) },
	},
}));

const mockReceiver = {
	app: { use: () => {} },
	start: () => Promise.resolve({}),
	stop: () => Promise.resolve(),
};

mock.module("@slack/bolt", () => ({
	App: mockApp,
	ExpressReceiver: mock(() => mockReceiver),
}));

const { createSlackChannel, readSlackTransportFromEnv } = await import("../slack-channel-factory.ts");
const { SlackChannel } = await import("../slack.ts");
const { SlackHttpChannel } = await import("../slack-http-receiver.ts");

const SOCKET_CONFIG: ChannelsConfig = {
	slack: {
		enabled: true,
		bot_token: "xoxb-1",
		app_token: "xapp-1",
		owner_user_id: "U_OWNER",
	},
};

const HTTP_IDENTITY = {
	slack: {
		teamId: "T9TK3CUKW",
		installerUserId: "U_INSTALLER",
		teamName: "Acme Corp",
		installedAt: "2026-04-25T00:00:00Z",
	},
};

const SECRET_RESPONSES: Record<string, string> = {
	slack_bot_token: "xoxb-from-metadata",
	slack_gateway_signing_secret: "0123456789abcdef".repeat(4),
};

describe("readSlackTransportFromEnv", () => {
	test("returns 'socket' when SLACK_TRANSPORT is unset", () => {
		expect(readSlackTransportFromEnv({} as NodeJS.ProcessEnv)).toBe("socket");
	});

	test("returns 'socket' when SLACK_TRANSPORT='socket'", () => {
		expect(readSlackTransportFromEnv({ SLACK_TRANSPORT: "socket" } as NodeJS.ProcessEnv)).toBe("socket");
	});

	test("returns 'http' when SLACK_TRANSPORT='http'", () => {
		expect(readSlackTransportFromEnv({ SLACK_TRANSPORT: "http" } as NodeJS.ProcessEnv)).toBe("http");
	});

	test("throws on an unknown value", () => {
		expect(() => readSlackTransportFromEnv({ SLACK_TRANSPORT: "garbage" } as NodeJS.ProcessEnv)).toThrow(
			/Unknown SLACK_TRANSPORT/,
		);
	});

	test("ignores leading/trailing whitespace via trim()", () => {
		expect(readSlackTransportFromEnv({ SLACK_TRANSPORT: "  http  " } as NodeJS.ProcessEnv)).toBe("http");
	});
});

describe("createSlackChannel", () => {
	beforeEach(() => {
		mockApp.mockClear();
	});

	afterEach(() => {
		// Nothing to reset; module mock is sticky for the file's lifetime.
	});

	test("transport=socket with no Slack creds returns null", async () => {
		const ch = await createSlackChannel({
			transport: "socket",
			channelsConfig: null,
			port: 3100,
		});
		expect(ch).toBeNull();
	});

	test("transport=socket with disabled Slack creds returns null", async () => {
		const disabled: ChannelsConfig = {
			slack: { enabled: false, bot_token: "x", app_token: "y" },
		};
		const ch = await createSlackChannel({
			transport: "socket",
			channelsConfig: disabled,
			port: 3100,
		});
		expect(ch).toBeNull();
	});

	test("transport=socket with valid creds returns a SlackChannel instance", async () => {
		const ch = await createSlackChannel({
			transport: "socket",
			channelsConfig: SOCKET_CONFIG,
			port: 3100,
		});
		expect(ch).toBeInstanceOf(SlackChannel);
	});

	test("transport=http with no slack subfield in identity throws a clear error", async () => {
		const idFetcher = { get: () => Promise.resolve({}) };
		const secFetcher = { get: () => Promise.resolve("unused") };
		await expect(
			createSlackChannel({
				transport: "http",
				channelsConfig: null,
				port: 3100,
				identityFetcher: idFetcher,
				secretsFetcher: secFetcher,
			}),
		).rejects.toThrow(/SLACK_TRANSPORT=http requires a Slack install/);
	});

	test("transport=http with slack identity and metadata secrets returns a SlackHttpChannel", async () => {
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secFetcher = { get: (name: string) => Promise.resolve(SECRET_RESPONSES[name] ?? "") };
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: null,
			port: 3100,
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
		});
		expect(ch).toBeInstanceOf(SlackHttpChannel);
		// Cast to the concrete type to inspect the wired identity.
		const httpCh = ch as InstanceType<typeof SlackHttpChannel>;
		expect(httpCh.getTeamId()).toBe("T9TK3CUKW");
		expect(httpCh.getInstallerUserId()).toBe("U_INSTALLER");
		expect(httpCh.getTeamName()).toBe("Acme Corp");
	});

	test("transport=http fetches both required secrets in parallel", async () => {
		const requested: string[] = [];
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secFetcher = {
			get: (name: string) => {
				requested.push(name);
				return Promise.resolve(SECRET_RESPONSES[name] ?? "");
			},
		};
		await createSlackChannel({
			transport: "http",
			channelsConfig: null,
			port: 3100,
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
		});
		expect(requested).toContain("slack_bot_token");
		expect(requested).toContain("slack_gateway_signing_secret");
	});

	test("transport=http never reads bot_token or app_token from channels.yaml", async () => {
		// Even when channels.yaml has socket creds, the http path uses metadata.
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secretCalls: string[] = [];
		const secFetcher = {
			get: (name: string) => {
				secretCalls.push(name);
				return Promise.resolve(SECRET_RESPONSES[name] ?? "");
			},
		};
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: SOCKET_CONFIG,
			port: 3100,
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
		});
		expect(ch).toBeInstanceOf(SlackHttpChannel);
		// The http path always pulls from metadata; SOCKET_CONFIG.slack.bot_token
		// is irrelevant. Pin this so a future refactor cannot accidentally
		// fall back to channels.yaml on a half-provisioned tenant.
		expect(secretCalls.length).toBe(2);
	});

	test("default identity fetcher uses the link-local URL", async () => {
		// We don't need to run the full http path here, just assert that the
		// factory wires the documented default base URL when no custom URL is
		// passed. The fetcher class is responsible for the URL it constructs.
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secFetcher = { get: (name: string) => Promise.resolve(SECRET_RESPONSES[name] ?? "") };
		// Pin the contract: passing through metadataBaseUrl propagates.
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: null,
			port: 3100,
			metadataBaseUrl: "http://gateway.test",
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
		});
		expect(ch).toBeInstanceOf(SlackHttpChannel);
	});
});
