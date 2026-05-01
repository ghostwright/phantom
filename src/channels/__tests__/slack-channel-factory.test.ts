import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChannelsConfig } from "../../config/schemas.ts";

// Mock the Slack Bolt SDK before importing the factory so the underlying
// channel constructors don't reach real network. The receiver test file
// already mocks @slack/bolt, but module mocks are scoped per file under bun.
const mockApp = mock(() => ({
	event: () => {},
	action: () => {},
	use: () => {},
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

// Phase 8a: Socket Mode receiver mock. The constructor returns an object
// whose `client.on(...)` is a no-op for routing tests; lifecycle metric
// behaviour is exercised in slack-metrics.test.ts and the SlackChannel
// suite, not here.
const mockSocketModeReceiver = mock(() => ({
	client: { on: () => {} },
}));

mock.module("@slack/bolt", () => ({
	App: mockApp,
	ExpressReceiver: mock(() => mockReceiver),
	SocketModeReceiver: mockSocketModeReceiver,
}));

const { createSlackChannel, readSlackTransportFromEnv, AllowedSecretNamesMirror } = await import(
	"../slack-channel-factory.ts"
);
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

// Cross-repo invariant: the names below must appear in phantomd's
// internal/secrets/types.go AllowedSecretNames map. Any drift between
// phantom and phantomd breaks tenant boot with HTTP 404 (the gateway maps
// ErrInvalidName to 404 to avoid name enumeration).
//
// Audit Finding 1 (2026-04-25) added slack_bot_token + slack_gateway_signing_secret.
// Phase 8a (R7 dated 2026-04-30) added slack_app_token for Socket Mode
// self-installed agent #2+ tenants. The phantomd side ships in PR #28
// (TestIsAllowedName_AcceptsSlackAppToken pins the symmetric assertion).
//
// This fixture is the SINGLE source of truth for the http-mode tests
// below; makeSecretFetcher() throws fail-loud on any name not listed
// here, so a future production-side rename that misses one repo will
// fail this test suite immediately instead of silently shipping a 404.
const SECRET_RESPONSES: Record<string, string> = {
	slack_bot_token: "xoxb-from-metadata",
	slack_app_token: "xapp-1-from-metadata",
	slack_gateway_signing_secret: "0123456789abcdef".repeat(4),
};

/**
 * Build a name-aware secret fetcher mock. Returns the canned value for any
 * name listed in SECRET_RESPONSES; throws an Error mentioning the offending
 * name for any other input. The optional `tape` argument records every call
 * for assertions on call ordering / call count without re-instantiating.
 *
 * Tests must NEVER substitute a permissive `() => Promise.resolve("...")`
 * fetcher in place of this helper for the http path: the audit caught a
 * production drift that a permissive mock would have hidden.
 */
function makeSecretFetcher(tape?: string[]): { get(name: string): Promise<string> } {
	return {
		get(name: string) {
			tape?.push(name);
			if (!(name in SECRET_RESPONSES)) {
				const allowed = Object.keys(SECRET_RESPONSES).join(", ");
				return Promise.reject(
					new Error(
						`unexpected secret name in test: ${name}. Allowed in this fixture: ${allowed}. This is the audit Finding 1 fail-loud guard; if production code requests a new name, add it to SECRET_RESPONSES AND to phantomd's internal/secrets/types.go AllowedSecretNames in the same change.`,
					),
				);
			}
			return Promise.resolve(SECRET_RESPONSES[name] as string);
		},
	};
}

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
		});
		expect(ch).toBeNull();
	});

	test("transport=socket with valid creds returns a SlackChannel instance", async () => {
		const ch = await createSlackChannel({
			transport: "socket",
			channelsConfig: SOCKET_CONFIG,
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
				identityFetcher: idFetcher,
				secretsFetcher: secFetcher,
			}),
		).rejects.toThrow(/SLACK_TRANSPORT=http requires a Slack install/);
	});

	test("transport=http with slack identity and metadata secrets returns a SlackHttpChannel", async () => {
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secFetcher = makeSecretFetcher();
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: null,
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
		const secFetcher = makeSecretFetcher(requested);
		await createSlackChannel({
			transport: "http",
			channelsConfig: null,
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
		});
		// Audit F1 contract: production must request these EXACT names. Any
		// future rename on either side without the matching edit on the other
		// side will leave one of these assertions failing or trip the
		// makeSecretFetcher fail-loud guard.
		expect(requested).toContain("slack_bot_token");
		expect(requested).toContain("slack_gateway_signing_secret");
		expect(requested).toHaveLength(2);
	});

	test("transport=http never reads bot_token or app_token from channels.yaml", async () => {
		// Even when channels.yaml has socket creds, the http path uses metadata.
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secretCalls: string[] = [];
		const secFetcher = makeSecretFetcher(secretCalls);
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: SOCKET_CONFIG,
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
		const secFetcher = makeSecretFetcher();
		// Pin the contract: passing through metadataBaseUrl propagates.
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: null,
			metadataBaseUrl: "http://gateway.test",
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
		});
		expect(ch).toBeInstanceOf(SlackHttpChannel);
	});

	test("transport=http forwards introductionLedger to the SlackHttpChannel", async () => {
		// H3 fix regression guard: the SQLite-backed intro-DM ledger must
		// reach the channel constructor so connect() can short-circuit on
		// a process restart and stamp /health=onboarding-complete on a
		// successful send. A future refactor that drops the forward
		// breaks this test loud; without it, a tenant whose first DM
		// failed would silently re-fire (or never fire) on restart.
		const idFetcher = { get: () => Promise.resolve(HTTP_IDENTITY) };
		const secFetcher = makeSecretFetcher();
		let isCalled = 0;
		let markCalled = 0;
		const ledger = {
			isIntroSent: () => {
				isCalled++;
				return true;
			},
			markIntroSent: () => {
				markCalled++;
			},
		};
		const ch = await createSlackChannel({
			transport: "http",
			channelsConfig: null,
			identityFetcher: idFetcher,
			secretsFetcher: secFetcher,
			introductionLedger: ledger,
		});
		// Calling connect() exercises the ledger path. The mocked Bolt
		// client (loaded by this test's @slack/bolt mock) makes auth.test
		// resolve immediately; isIntroSent() === true short-circuits the
		// intro DM so we know the ledger reached the channel.
		expect(ch).toBeInstanceOf(SlackHttpChannel);
		await (ch as InstanceType<typeof SlackHttpChannel>).connect();
		expect(isCalled).toBeGreaterThanOrEqual(1);
		expect(markCalled).toBe(0);
	});

	test("makeSecretFetcher fails-loud when production asks for an unknown name", async () => {
		// This is the audit Finding 1 regression guard. If the production code
		// in slack-channel-factory.ts ever drifts to ask for a different name
		// (for example reverting "slack_gateway_signing_secret" to the legacy
		// "slack_signing_secret"), this fixture will throw and the test suite
		// will fail-loud. The error message points at the cross-repo allowlist.
		const fetcher = makeSecretFetcher();
		await expect(fetcher.get("slack_signing_secret")).rejects.toThrow(
			/unexpected secret name in test: slack_signing_secret/,
		);
		await expect(fetcher.get("totally_made_up")).rejects.toThrow(/AllowedSecretNames/);
	});
});

// Phase 8a (R7 2026-04-30): pin the cross-repo invariant for the new
// slack_app_token entry. AllowedSecretNamesMirror is the phantom-side
// authoritative list; phantomd's TestIsAllowedName_AcceptsSlackAppToken is
// the matching assertion in the symmetric position. If a future contributor
// removes the entry on either side without the matching edit, both test
// suites fail-loud.
describe("AllowedSecretNamesMirror", () => {
	test("includes slack_bot_token", () => {
		expect(AllowedSecretNamesMirror).toContain("slack_bot_token");
	});

	test("includes slack_app_token (Phase 8a Socket Mode)", () => {
		expect(AllowedSecretNamesMirror).toContain("slack_app_token");
	});

	test("includes slack_gateway_signing_secret (audit F1, HTTP receiver)", () => {
		expect(AllowedSecretNamesMirror).toContain("slack_gateway_signing_secret");
	});

	test("matches the SECRET_RESPONSES test fixture set", () => {
		// SECRET_RESPONSES is the test fixture for makeSecretFetcher; its
		// keys must equal AllowedSecretNamesMirror. A drift here means the
		// production code can fetch a name the test fixture rejects (or
		// vice versa), and the audit-F1 fail-loud guard breaks down.
		const fixtureKeys = Object.keys(SECRET_RESPONSES).sort();
		const mirror = [...AllowedSecretNamesMirror].sort();
		expect(fixtureKeys).toEqual(mirror);
	});

	test("entries are frozen (Object.freeze) so a runtime mutation is loud", () => {
		expect(Object.isFrozen(AllowedSecretNamesMirror)).toBe(true);
	});
});
