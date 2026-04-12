import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RoleRegistry, createRoleRegistry, loadAllRoles, loadRole } from "../registry.ts";
import type { RoleTemplate } from "../types.ts";

const TEST_DIR = join(import.meta.dir, ".test-roles-registry");

function makeTemplate(overrides: Partial<RoleTemplate> = {}): RoleTemplate {
	return {
		id: "test",
		name: "Test Role",
		description: "A test role",
		identity: "You are a test agent.",
		capabilities: ["Testing things"],
		communication: "Be direct.",
		workflow_spec: "",
		onboarding_questions: [],
		mcp_tools: [],
		evolution_focus: { priorities: ["testing"], feedback_signals: [] },
		initial_config: { persona: "", domain_knowledge: "", task_patterns: "", tool_preferences: "" },
		systemPromptSection: "# Role\n\nYou are a test agent.",
		...overrides,
	};
}

describe("RoleRegistry", () => {
	test("register and get a role", () => {
		const registry = new RoleRegistry();
		const template = makeTemplate();
		registry.register(template);

		const result = registry.get("test");
		expect(result).not.toBeNull();
		expect(result?.id).toBe("test");
		expect(result?.name).toBe("Test Role");
	});

	test("returns null for unknown role", () => {
		const registry = new RoleRegistry();
		expect(registry.get("nonexistent")).toBeNull();
	});

	test("getOrThrow throws for unknown role", () => {
		const registry = new RoleRegistry();
		registry.register(makeTemplate());

		expect(() => registry.getOrThrow("nonexistent")).toThrow("Role 'nonexistent' not found");
	});

	test("getOrThrow returns role when it exists", () => {
		const registry = new RoleRegistry();
		registry.register(makeTemplate());

		const role = registry.getOrThrow("test");
		expect(role.id).toBe("test");
	});

	test("list returns all registered role IDs", () => {
		const registry = new RoleRegistry();
		registry.register(makeTemplate({ id: "swe", name: "SWE" }));
		registry.register(makeTemplate({ id: "data", name: "Data" }));
		registry.register(makeTemplate({ id: "cos", name: "CoS" }));

		const list = registry.list();
		expect(list).toHaveLength(3);
		expect(list).toContain("swe");
		expect(list).toContain("data");
		expect(list).toContain("cos");
	});

	test("listDetailed returns role details", () => {
		const registry = new RoleRegistry();
		registry.register(
			makeTemplate({
				id: "swe",
				name: "Software Engineer",
				description: "Writes code",
				mcp_tools: [{ name: "tool1", description: "desc" }],
			}),
		);

		const details = registry.listDetailed();
		expect(details).toHaveLength(1);
		expect(details[0].id).toBe("swe");
		expect(details[0].name).toBe("Software Engineer");
		expect(details[0].toolCount).toBe(1);
	});

	test("has returns true for registered roles", () => {
		const registry = new RoleRegistry();
		registry.register(makeTemplate());

		expect(registry.has("test")).toBe(true);
		expect(registry.has("other")).toBe(false);
	});

	test("getOnboardingQuestions returns questions for a role", () => {
		const registry = new RoleRegistry();
		registry.register(
			makeTemplate({
				onboarding_questions: [
					{ id: "q1", question: "What repos?", type: "text", required: true },
					{ id: "q2", question: "What stack?", type: "multiline", required: false },
				],
			}),
		);

		const questions = registry.getOnboardingQuestions("test");
		expect(questions).toHaveLength(2);
		expect(questions[0].id).toBe("q1");
	});

	test("getOnboardingQuestions returns empty for unknown role", () => {
		const registry = new RoleRegistry();
		expect(registry.getOnboardingQuestions("nonexistent")).toEqual([]);
	});

	test("getEvolutionFocus returns focus for a role", () => {
		const registry = new RoleRegistry();
		registry.register(
			makeTemplate({
				evolution_focus: {
					priorities: ["coding_patterns", "ci_failures"],
					feedback_signals: ["pr_approved"],
				},
			}),
		);

		const focus = registry.getEvolutionFocus("test");
		expect(focus).not.toBeNull();
		expect(focus?.priorities).toContain("coding_patterns");
		expect(focus?.feedback_signals).toContain("pr_approved");
	});

	test("getEvolutionFocus returns null for unknown role", () => {
		const registry = new RoleRegistry();
		expect(registry.getEvolutionFocus("nonexistent")).toBeNull();
	});

	test("register with module stores the module", () => {
		const registry = new RoleRegistry();
		const mod = { tools: [] };
		registry.register(makeTemplate(), mod);

		const result = registry.getModule("test");
		expect(result).not.toBeNull();
		expect(result?.tools).toEqual([]);
	});

	test("getTools returns empty for role without module", () => {
		const registry = new RoleRegistry();
		registry.register(makeTemplate());

		expect(registry.getTools("test")).toEqual([]);
	});
});

describe("loadAllRoles", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("loads all YAML role configs from directory", () => {
		writeFileSync(
			join(TEST_DIR, "alpha.yaml"),
			`id: alpha
name: Alpha Role
description: The alpha role.
identity: You are alpha.
capabilities:
  - Do alpha things
communication: Be alpha.
evolution_focus:
  priorities:
    - alpha_priority
`,
		);

		writeFileSync(
			join(TEST_DIR, "beta.yaml"),
			`id: beta
name: Beta Role
description: The beta role.
identity: You are beta.
capabilities:
  - Do beta things
communication: Be beta.
evolution_focus:
  priorities:
    - beta_priority
`,
		);

		const registry = new RoleRegistry();
		loadAllRoles(registry, TEST_DIR);

		expect(registry.has("alpha")).toBe(true);
		expect(registry.has("beta")).toBe(true);
		expect(registry.list()).toHaveLength(2);
	});

	test("skips invalid YAML gracefully", () => {
		writeFileSync(
			join(TEST_DIR, "good.yaml"),
			`id: good
name: Good Role
description: A good role.
identity: You are good.
capabilities:
  - Be good
communication: Be good.
evolution_focus:
  priorities:
    - goodness
`,
		);

		writeFileSync(join(TEST_DIR, "bad.yaml"), "invalid: yaml: with: no: required: fields");

		const registry = new RoleRegistry();
		loadAllRoles(registry, TEST_DIR);

		expect(registry.has("good")).toBe(true);
		expect(registry.has("bad")).toBe(false);
	});
});

describe("loadRole", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("loads a single role by ID", () => {
		writeFileSync(
			join(TEST_DIR, "single.yaml"),
			`id: single
name: Single Role
description: Just one role.
identity: You are single.
capabilities:
  - Do single things
communication: Be single.
evolution_focus:
  priorities:
    - single_priority
`,
		);

		const registry = new RoleRegistry();
		const template = loadRole(registry, "single", TEST_DIR);

		expect(template.id).toBe("single");
		expect(template.name).toBe("Single Role");
		expect(registry.has("single")).toBe(true);
	});

	test("throws for missing role ID", () => {
		expect(() => {
			const registry = new RoleRegistry();
			loadRole(registry, "nonexistent", TEST_DIR);
		}).toThrow("Role config not found");
	});
});

describe("createRoleRegistry", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("creates a pre-populated registry", () => {
		writeFileSync(
			join(TEST_DIR, "auto.yaml"),
			`id: auto
name: Auto Role
description: Auto-loaded.
identity: You are auto.
capabilities:
  - Auto things
communication: Be automatic.
evolution_focus:
  priorities:
    - automation
`,
		);

		const registry = createRoleRegistry(TEST_DIR);
		expect(registry.has("auto")).toBe(true);
	});
});
