import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runMigrations } from "../../db/migrate.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import { type OnboardingTarget, startOnboarding } from "../flow.ts";
import type { SlackProfileClient } from "../profiler.ts";
import { getOnboardingStatus } from "../state.ts";

const mockRole: RoleTemplate = {
	id: "swe",
	name: "Software Engineer",
	description: "A software engineering co-worker",
	identity: "You are a software engineer.",
	capabilities: ["Write code"],
	communication: "Concise and technical.",
	workflow_spec: "",
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

		const profile = await startOnboarding(slack as never, target, "Scout", mockRole, db, client);

		expect(profile).not.toBeNull();
		expect(profile?.name).toBe("Cheema");
		expect(profile?.title).toBe("Founder");
		expect(profile?.teamName).toBe("Ghostwright");
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

		const profile = await startOnboarding(slack as never, target, "Scout", mockRole, db, failingClient);

		const text = slack.sendDm.mock.calls[0][1] as string;
		// Generic fallback when profile has no real data
		expect(text).toContain("Hey there. I'm Scout");
		expect(profile).toBeNull();
	});

	test("does not profile for channel targets", async () => {
		const slack = createMockSlack();
		const client = createMockSlackClient();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		await startOnboarding(slack as never, target, "Scout", mockRole, db, client);

		expect(client.users.info).not.toHaveBeenCalled();
	});

	test("returns null when target is channel", async () => {
		const slack = createMockSlack();
		const target: OnboardingTarget = { type: "channel", channelId: "C04ABC123" };

		const profile = await startOnboarding(slack as never, target, "Scout", mockRole, db);

		expect(profile).toBeNull();
	});
});
