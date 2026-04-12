import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listAvailableRoles, loadRoleFromYaml } from "../loader.ts";

const TEST_DIR = join(import.meta.dir, ".test-roles-loader");

describe("loadRoleFromYaml", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("loads a valid role YAML", () => {
		writeFileSync(
			join(TEST_DIR, "swe.yaml"),
			`id: swe
name: Software Engineer
description: A software engineering co-worker.
identity: You are a software engineer.
capabilities:
  - Write code
  - Review PRs
  - Debug issues
communication: Be concise and technical.
onboarding_questions:
  - id: repos
    question: "What repos?"
    type: text
    required: true
mcp_tools:
  - name: phantom_codebase_query
    description: Query the codebase
evolution_focus:
  priorities:
    - coding_patterns
    - ci_failures
  feedback_signals:
    - pr_approved
    - thumbs_up_reaction
initial_config:
  persona: "Technical communication style."
  domain_knowledge: ""
  task_patterns: "Read code first, then implement."
  tool_preferences: "Use grep before writing."
`,
		);

		const template = loadRoleFromYaml("swe", TEST_DIR);

		expect(template.id).toBe("swe");
		expect(template.name).toBe("Software Engineer");
		expect(template.capabilities).toHaveLength(3);
		expect(template.onboarding_questions).toHaveLength(1);
		expect(template.onboarding_questions[0].id).toBe("repos");
		expect(template.mcp_tools).toHaveLength(1);
		expect(template.mcp_tools[0].name).toBe("phantom_codebase_query");
		expect(template.evolution_focus.priorities).toContain("coding_patterns");
		expect(template.evolution_focus.feedback_signals).toContain("pr_approved");
		expect(template.initial_config.persona).toContain("Technical");
	});

	test("generates systemPromptSection from identity + capabilities + communication", () => {
		writeFileSync(
			join(TEST_DIR, "minimal.yaml"),
			`id: minimal
name: Minimal
description: A minimal role.
identity: You are minimal.
capabilities:
  - Be minimal
communication: Say little.
evolution_focus:
  priorities:
    - minimalism
`,
		);

		const template = loadRoleFromYaml("minimal", TEST_DIR);

		expect(template.systemPromptSection).toContain("# Role");
		expect(template.systemPromptSection).toContain("You are minimal.");
		expect(template.systemPromptSection).toContain("# Capabilities");
		expect(template.systemPromptSection).toContain("- Be minimal");
		expect(template.systemPromptSection).toContain("# Communication Style");
		expect(template.systemPromptSection).toContain("Say little.");
	});

	test("provides defaults for optional fields", () => {
		writeFileSync(
			join(TEST_DIR, "defaults.yaml"),
			`id: defaults
name: Defaults Role
description: Tests defaults.
identity: You have defaults.
capabilities:
  - Default things
communication: Default style.
evolution_focus:
  priorities:
    - default_priority
`,
		);

		const template = loadRoleFromYaml("defaults", TEST_DIR);

		expect(template.onboarding_questions).toEqual([]);
		expect(template.mcp_tools).toEqual([]);
		expect(template.evolution_focus.feedback_signals).toEqual([]);
		expect(template.initial_config.persona).toBe("");
		expect(template.initial_config.domain_knowledge).toBe("");
	});

	test("throws for missing YAML file", () => {
		expect(() => loadRoleFromYaml("nonexistent", TEST_DIR)).toThrow("Role config not found");
	});

	test("throws for invalid YAML content", () => {
		writeFileSync(join(TEST_DIR, "invalid.yaml"), "id: invalid\n# missing required fields");

		expect(() => loadRoleFromYaml("invalid", TEST_DIR)).toThrow("Invalid role config");
	});

	test("validates onboarding question types", () => {
		writeFileSync(
			join(TEST_DIR, "badq.yaml"),
			`id: badq
name: Bad Questions
description: Has bad questions.
identity: You have bad questions.
capabilities:
  - Ask bad questions
communication: Badly.
onboarding_questions:
  - id: q1
    question: "What?"
    type: invalid_type
    required: true
evolution_focus:
  priorities:
    - questioning
`,
		);

		expect(() => loadRoleFromYaml("badq", TEST_DIR)).toThrow("Invalid role config");
	});

	test("appends workflow_spec to systemPromptSection under a Workflow heading", () => {
		writeFileSync(
			join(TEST_DIR, "withwf.yaml"),
			`id: withwf
name: With Workflow
description: Has a workflow spec.
identity: You enforce workflows.
capabilities:
  - Enforce things
communication: Direct.
workflow_spec: |
  # GitHub Workflow

  Never squash. Never amend. Never force-push.
evolution_focus:
  priorities:
    - workflow_compliance
`,
		);

		const template = loadRoleFromYaml("withwf", TEST_DIR);

		expect(template.systemPromptSection).toContain("# Workflow");
		expect(template.systemPromptSection).toContain("Never squash. Never amend. Never force-push.");
		const commIdx = template.systemPromptSection.indexOf("# Communication Style");
		const wfIdx = template.systemPromptSection.indexOf("# Workflow");
		expect(commIdx).toBeGreaterThan(-1);
		expect(wfIdx).toBeGreaterThan(commIdx);
	});

	test("omits Workflow heading when workflow_spec is empty", () => {
		writeFileSync(
			join(TEST_DIR, "nowf.yaml"),
			`id: nowf
name: No Workflow
description: No workflow.
identity: You have no workflow.
capabilities:
  - Nothing
communication: Whatever.
evolution_focus:
  priorities:
    - nothing
`,
		);
		const template = loadRoleFromYaml("nowf", TEST_DIR);
		expect(template.systemPromptSection).not.toContain("# Workflow");
	});

	test("validates evolution_focus has at least one priority", () => {
		writeFileSync(
			join(TEST_DIR, "noprio.yaml"),
			`id: noprio
name: No Priorities
description: No focus priorities.
identity: You have no priorities.
capabilities:
  - Nothing
communication: Whatever.
evolution_focus:
  priorities: []
`,
		);

		expect(() => loadRoleFromYaml("noprio", TEST_DIR)).toThrow("Invalid role config");
	});
});

describe("listAvailableRoles", () => {
	beforeEach(() => {
		mkdirSync(TEST_DIR, { recursive: true });
	});

	afterEach(() => {
		rmSync(TEST_DIR, { recursive: true, force: true });
	});

	test("lists YAML files in the roles directory", () => {
		writeFileSync(join(TEST_DIR, "alpha.yaml"), "");
		writeFileSync(join(TEST_DIR, "beta.yaml"), "");
		writeFileSync(join(TEST_DIR, "gamma.txt"), ""); // Not a YAML file

		const roles = listAvailableRoles(TEST_DIR);
		expect(roles).toHaveLength(2);
		expect(roles).toContain("alpha");
		expect(roles).toContain("beta");
	});

	test("returns empty array for non-existent directory", () => {
		const roles = listAvailableRoles("/nonexistent/path");
		expect(roles).toEqual([]);
	});
});
