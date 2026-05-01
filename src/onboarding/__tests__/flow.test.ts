import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import { type OnboardingTarget, appendResearchSection, startOnboarding } from "../flow.ts";
import type { SlackProfileClient } from "../profiler.ts";
import { getFirstbootState, getOnboardingStatus, isIntroSent } from "../state.ts";

const mockRole: RoleTemplate = {
	id: "swe",
	name: "Software Engineer",
	description: "A software engineering co-worker",
	identity: "You are a software engineer.",
	capabilities: ["Write code"],
	communication: "Concise and technical.",
	onboarding_questions: [],
	mcp_tools: [],
	evolution_focus: { priorities: ["coding_patterns"], feedback_signals: [] },
	initial_config: { persona: "", domain_knowledge: "", task_patterns: "", tool_preferences: "" },
	systemPromptSection: "## Software Engineer\nYou are a software engineer.",
};

function createMockSlack(): {
	postToChannel: ReturnType<typeof mock>;
	sendDm: ReturnType<typeof mock>;
} {
	return {
		postToChannel: mock(() => Promise.resolve("1234567890.123456")),
		sendDm: mock(() => Promise.resolve("1234567890.123456")),
	};
}

function createMockSlackClient(): SlackProfileClient {
	return {
		users: {
			info: mock(() =>
				Promise.resolve({
					user: {
						real_name: "Cheema",
						name: "cheema",
						tz_label: "Pacific Daylight Time",
						is_admin: true,
						is_owner: true,
						profile: {
							title: "Founder",
							status_text: "Building Ghost OS",
						},
					},
				}),
			),
			conversations: mock(() =>
				Promise.resolve({
					channels: [{ name: "engineering" }, { name: "infrastructure" }],
				}),
			),
		},
		team: {
			info: mock(() =>
				Promise.resolve({
					team: { name: "Ghostwright" },
				}),
			),
		},
	};
}

describe("startOnboarding", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	test("posts intro to channel when target is channel", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db);

		expect(slack.postToChannel).toHaveBeenCalledTimes(1);
		const [channelId, text] = slack.postToChannel.mock.calls[0];
		expect(channelId).toBe("C04ABC123");
		expect(text).toContain("Scout");
		expect(text).toContain("just got spun up");
	});

	test("sends DM when target is dm", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U04XYZ789" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db);

		expect(slack.sendDm).toHaveBeenCalledTimes(1);
		const [userId, text] = slack.sendDm.mock.calls[0];
		expect(userId).toBe("U04XYZ789");
		expect(text).toContain("Scout");
	});

	test("marks onboarding as started in database", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db);

		const status = getOnboardingStatus(db);
		expect(status.status).toBe("in_progress");
	});

	test("generic intro message is warm and natural", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db);

		const text = slack.postToChannel.mock.calls[0][1] as string;
		expect(text).toContain("Hey there. I'm Scout");
		expect(text).toContain("just got spun up");
		expect(text).toContain("What are you working on");
	});

	test("generic intro includes phantom name and capabilities hint", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U04XYZ789" };

		await startOnboarding(slack as never, target, "Atlas", mockRole, db);

		const text = slack.sendDm.mock.calls[0][1] as string;
		expect(text).toContain("Atlas");
		expect(text).toContain("research, code, data");
	});

	test("does not call sendDm for channel target", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db);

		expect(slack.sendDm).not.toHaveBeenCalled();
	});

	test("does not call postToChannel for dm target", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U04XYZ789" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db);

		expect(slack.postToChannel).not.toHaveBeenCalled();
	});
});

describe("startOnboarding with profiling", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	test("sends personalized DM when profile is available", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "dm", userId: "U0A9P3CC5EE" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, client);

		expect(slack.sendDm).toHaveBeenCalledTimes(1);
		const text = slack.sendDm.mock.calls[0][1] as string;
		expect(text).toContain("Hey Cheema");
		expect(text).toContain("Ghostwright");
		expect(text).toContain("Scout");
	});

	test("personalized DM mentions workspace name", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "dm", userId: "U0A9P3CC5EE" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, client);

		const text = slack.sendDm.mock.calls[0][1] as string;
		expect(text).toContain("Ghostwright");
		expect(text).toContain("learn from every conversation");
	});

	test("returns owner profile when profiling succeeds", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "dm", userId: "U0A9P3CC5EE" };

		const result = await startOnboarding(slack as never, target, "Scout", mockRole, db, client);

		expect(result.profile).not.toBeNull();
		expect(result.profile?.name).toBe("Cheema");
		expect(result.profile?.title).toBe("Founder");
		expect(result.profile?.teamName).toBe("Ghostwright");
		expect(result.skipped).toBe(false);
	});

	test("falls back to generic intro when profiling fails", async () => {
		const slack = createMockSlack();
		const failingClient: SlackProfileClient = {
			users: {
				info: mock(() => Promise.reject(new Error("network_error"))),
				conversations: mock(() => Promise.reject(new Error("network_error"))),
			},
			team: {
				info: mock(() => Promise.reject(new Error("network_error"))),
			},
		};
		const target: OnboardingTarget = { type: "dm", userId: "U04XYZ789" };

		const result = await startOnboarding(slack as never, target, "Scout", mockRole, db, failingClient);

		const text = slack.sendDm.mock.calls[0][1] as string;
		expect(text).toContain("Hey there. I'm Scout");
		expect(result.profile).toBeNull();
	});

	test("does not profile for channel targets", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, client);

		expect(client.users.info).not.toHaveBeenCalled();
	});

	test("returns null profile when target is channel", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		const result = await startOnboarding(slack as never, target, "Scout", mockRole, db);

		expect(result.profile).toBeNull();
	});
});

describe("appendResearchSection", () => {
	test("returns the original message when research is null", () => {
		expect(appendResearchSection("hi", null)).toBe("hi");
	});

	test("returns the original message when bullets is null", () => {
		expect(appendResearchSection("hi", { bullets: null, sources: [], outcome: "empty" })).toBe("hi");
	});

	test("appends bullets when present", () => {
		const out = appendResearchSection("hi", {
			bullets: ["First bullet.", "Second bullet."],
			sources: [
				{ kind: "github", url: "https://github.com/x" },
				{ kind: "personal_site", url: "https://x.com" },
			],
			outcome: "ok",
		});
		expect(out).toContain("hi");
		expect(out).toContain("What I learned about you so far");
		expect(out).toContain("- First bullet.");
		expect(out).toContain("- Second bullet.");
	});
});

describe("Phase 12 idempotency in startOnboarding", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	test("first call sends the DM and stamps the firstboot ledger", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };

		const result = await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			researchEnabled: false,
		});

		expect(result.skipped).toBe(false);
		expect(slack.sendDm).toHaveBeenCalledTimes(1);
		expect(isIntroSent(db)).toBe(true);
	});

	test("second call skips entirely when ledger says intro_sent_at is set", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, { researchEnabled: false });
		const callsAfterFirst = slack.sendDm.mock.calls.length;

		const second = await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			researchEnabled: false,
		});

		expect(second.skipped).toBe(true);
		expect(slack.sendDm.mock.calls.length).toBe(callsAfterFirst);
	});

	test("ledger records the research outcome", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C001" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			ownerEmail: "matt@acme.com",
			enrichImpl: async () => ({
				bullets: ["b1"],
				sources: [{ kind: "github", url: "https://github.com/matt" }],
				outcome: "ok",
			}),
		});

		expect(getFirstbootState(db).research_outcome).toBe("ok");
	});

	test("does not stamp ledger when sendDm throws (so a retry can happen)", async () => {
		const slack = {
			sendDm: mock(() => Promise.reject(new Error("slack down"))),
			postToChannel: mock(() => Promise.resolve("1.0")),
		};
		const target: OnboardingTarget = { type: "dm", userId: "U001" };

		await expect(
			startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, { researchEnabled: false }),
		).rejects.toThrow("slack down");

		expect(isIntroSent(db)).toBe(false);
	});
});

describe("Phase 12 research integration in startOnboarding", () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(":memory:");
		db.run("PRAGMA journal_mode = WAL");
		db.run("PRAGMA foreign_keys = ON");
		runMigrations(db);
	});

	afterEach(() => {
		db.close();
	});

	test("research bullets are appended to the intro DM", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			ownerEmail: "matt@acme.com",
			ownerName: "Matt Example",
			enrichImpl: async () => ({
				bullets: ["On GitHub as @matt: building developer tools.", "Their site at acme.com: Acme builds tools."],
				sources: [
					{ kind: "github", url: "https://github.com/matt" },
					{ kind: "personal_site", url: "https://acme.com" },
				],
				outcome: "ok",
			}),
		});

		const text = slack.sendDm.mock.calls[0][1] as string;
		expect(text).toContain("What I learned about you so far");
		expect(text).toContain("@matt");
		expect(text).toContain("acme.com");
	});

	test("empty research result does NOT add the section", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			ownerEmail: "matt@acme.com",
			enrichImpl: async () => ({ bullets: null, sources: [], outcome: "empty" }),
		});

		const text = slack.sendDm.mock.calls[0][1] as string;
		expect(text).not.toContain("What I learned about you so far");
	});

	test("network failure during research still sends the intro DM", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C001" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			ownerEmail: "matt@acme.com",
			enrichImpl: async () => {
				throw new Error("ENETDOWN");
			},
		});

		expect(slack.postToChannel).toHaveBeenCalledTimes(1);
		expect(getFirstbootState(db).research_outcome).toBe("error");
	});

	test("researchEnabled=false skips research entirely", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };
		const enrich = mock(() => Promise.resolve({ bullets: ["b"], sources: [], outcome: "ok" as const }));

		await startOnboarding(slack as never, target, "Scout", mockRole, db, undefined, {
			ownerEmail: "matt@acme.com",
			researchEnabled: false,
			enrichImpl: enrich,
		});

		expect(enrich).not.toHaveBeenCalled();
	});

	test("Slack profile name is used as fallback for research input", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };
		const enrich = mock(() => Promise.resolve({ bullets: null, sources: [], outcome: "empty" as const })) as never;

		await startOnboarding(slack as never, target, "Scout", mockRole, db, client, {
			ownerEmail: "matt@acme.com",
			enrichImpl: enrich as never,
		});

		const seen = (enrich as unknown as { mock: { calls: Array<[{ name?: string }]> } }).mock.calls[0][0].name;
		expect(seen).toBe("Cheema");
	});

	test("explicit ownerName beats Slack profile name", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "dm", userId: "U001" };
		const enrich = mock(() => Promise.resolve({ bullets: null, sources: [], outcome: "empty" as const })) as never;

		await startOnboarding(slack as never, target, "Scout", mockRole, db, client, {
			ownerEmail: "matt@acme.com",
			ownerName: "Override Name",
			enrichImpl: enrich as never,
		});

		const seen = (enrich as unknown as { mock: { calls: Array<[{ name?: string }]> } }).mock.calls[0][0].name;
		expect(seen).toBe("Override Name");
	});
});
