import { describe, expect, test } from "bun:test";
import type { OwnerResearchResult } from "../../agent/research/types.ts";
import type { RoleTemplate } from "../../roles/types.ts";
import type { OwnerProfile } from "../profiler.ts";
import { buildOnboardingPrompt, buildResearchContext } from "../prompt.ts";

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

const fullProfile: OwnerProfile = {
	name: "Cheema",
	title: "Founder",
	timezone: "Pacific Daylight Time",
	status: "Building Ghost OS",
	isAdmin: true,
	isOwner: true,
	teamName: "Ghostwright",
	channels: ["engineering", "infrastructure", "deploys"],
};

describe("buildOnboardingPrompt", () => {
	test("includes phantom name", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("You are Scout");
	});

	test("includes phantom name in conversation context", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("You are Scout");
	});

	test("includes onboarding mode header", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("## Onboarding Mode");
	});

	test("tells agent to clone repos", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("git clone");
	});

	test("tells agent to explore code", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("Read the code");
	});

	test("tells agent to write evolved config files", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("phantom-config/user-profile.md");
		expect(prompt).toContain("phantom-config/domain-knowledge.md");
	});

	test("tells agent to have natural conversation", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("natural conversation");
		expect(prompt).toContain("Listen to what they tell you");
	});

	test("tells agent about available tools", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("Bash");
		expect(prompt).toContain("Read");
		expect(prompt).toContain("Write");
		expect(prompt).toContain("Glob");
		expect(prompt).toContain("Grep");
	});

	test("tells agent to write config files", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).toContain("phantom-config/user-profile.md");
		expect(prompt).toContain("phantom-config/domain-knowledge.md");
	});

	test("different name produces different prompt", () => {
		const prompt1 = buildOnboardingPrompt(mockRole, "Scout");
		const prompt2 = buildOnboardingPrompt(mockRole, "Atlas");
		expect(prompt1).not.toBe(prompt2);
		expect(prompt2).toContain("You are Atlas");
	});
});

describe("buildOnboardingPrompt with owner profile", () => {
	test("includes owner context section", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("## Owner Context");
	});

	test("includes owner name", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("Cheema");
	});

	test("includes owner title", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("Founder");
	});

	test("includes workspace name", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("Ghostwright");
	});

	test("includes timezone", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("Pacific Daylight Time");
	});

	test("includes status text", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("Building Ghost OS");
	});

	test("includes channel names", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("engineering");
		expect(prompt).toContain("infrastructure");
		expect(prompt).toContain("deploys");
	});

	test("includes workspace owner indicator", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("workspace owner");
	});

	test("tells agent not to dump data back", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", fullProfile);
		expect(prompt).toContain("Do not list all this information back");
		expect(prompt).toContain("Let it inform how you");
	});

	test("omits owner context when no profile provided", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout");
		expect(prompt).not.toContain("## Owner Context");
	});

	test("handles profile with minimal data", () => {
		const minimalProfile: OwnerProfile = {
			name: "Sam",
			title: null,
			timezone: null,
			status: null,
			isAdmin: false,
			isOwner: false,
			teamName: null,
			channels: [],
		};
		const prompt = buildOnboardingPrompt(mockRole, "Scout", minimalProfile);
		expect(prompt).toContain("## Owner Context");
		expect(prompt).toContain("Sam");
		expect(prompt).not.toContain("workspace owner");
		expect(prompt).not.toContain("active in these channels");
	});

	test("shows admin status when not owner", () => {
		const adminProfile: OwnerProfile = {
			...fullProfile,
			isOwner: false,
			isAdmin: true,
		};
		const prompt = buildOnboardingPrompt(mockRole, "Scout", adminProfile);
		expect(prompt).toContain("workspace admin");
		expect(prompt).not.toContain("workspace owner");
	});
});

describe("buildResearchContext", () => {
	const research: OwnerResearchResult = {
		bullets: ["On GitHub as @matt: building tools.", "LinkedIn headline: Senior Engineer."],
		sources: [
			{ kind: "github", url: "https://github.com/matt" },
			{ kind: "linkedin_public", url: "https://www.linkedin.com/in/matt" },
		],
		outcome: "ok",
	};

	test("returns empty string when research is null", () => {
		expect(buildResearchContext(null)).toBe("");
	});

	test("returns empty string when bullets is null", () => {
		expect(buildResearchContext({ bullets: null, sources: [], outcome: "empty" })).toBe("");
	});

	test("returns empty string when bullets is empty", () => {
		expect(buildResearchContext({ bullets: [], sources: [], outcome: "ok" })).toBe("");
	});

	test("emits the public-sources heading when bullets exist", () => {
		const out = buildResearchContext(research);
		expect(out).toContain("## What I Learned About Them (Public Sources)");
	});

	test("includes each bullet with its source kind tag", () => {
		const out = buildResearchContext(research);
		expect(out).toContain("- On GitHub as @matt");
		expect(out).toContain("[github]");
		expect(out).toContain("[linkedin_public]");
	});

	test("warns the agent against treating public bullets as deep knowledge", () => {
		const out = buildResearchContext(research);
		expect(out).toContain("public sources only");
		expect(out).toContain("Verify with the user");
	});
});

describe("buildOnboardingPrompt with research", () => {
	const minimalResearch: OwnerResearchResult = {
		bullets: ["On GitHub as @matt: building tools."],
		sources: [{ kind: "github", url: "https://github.com/matt" }],
		outcome: "ok",
	};

	test("research section appears when bullets are present", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", undefined, minimalResearch);
		expect(prompt).toContain("## What I Learned About Them");
		expect(prompt).toContain("@matt");
	});

	test("research section is omitted when research is null", () => {
		const prompt = buildOnboardingPrompt(mockRole, "Scout", undefined, null);
		expect(prompt).not.toContain("## What I Learned About Them");
	});

	test("research and owner profile coexist", () => {
		const profile: OwnerProfile = {
			name: "Cheema",
			title: "Founder",
			timezone: null,
			status: null,
			isAdmin: true,
			isOwner: true,
			teamName: "Ghostwright",
			channels: [],
		};
		const prompt = buildOnboardingPrompt(mockRole, "Scout", profile, minimalResearch);
		expect(prompt).toContain("## Owner Context");
		expect(prompt).toContain("## What I Learned About Them");
		// Research section appears AFTER owner context.
		expect(prompt.indexOf("## What I Learned About Them")).toBeGreaterThan(prompt.indexOf("## Owner Context"));
	});
});
